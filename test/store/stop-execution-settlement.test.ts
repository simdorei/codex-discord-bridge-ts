import {settleStoppedExecutionIn} from '../../src/store/async-history.ts';
import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {historicalQuestionFixture} from "../helpers/async-history-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {captureTerminalHistorySnapshot,settleTerminalHistory,type TerminalHistorySnapshot} from "../../src/store/async-history.ts";
import {serializeSerdeValue,sha256SerdeValue} from "../../src/core/serde-json.ts";
import {readAsyncObligationsIn} from "../../src/store/async-resolution-records.ts";
import {serializeTerminalEvidence} from "../../src/store/async-resolution-proof.ts";
async function fixture(run:(db:DatabaseSync,path:string,snapshot:TerminalHistorySnapshot)=>Promise<void>):Promise<void>{
  await storeFixture(async path=>{
    const f=historicalQuestionFixture(),db=await openInitialized(path);
    try{
      db.exec("INSERT INTO mirror_threads VALUES ('target','project','title',1,1,0)");
      db.prepare(`INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,
        body,owner_confirmed,state,message_id,chosen,dispatch_mode,preparation_json,created_at,updated_at)
        VALUES ('q','resident',1,'target','turn','item','job',1,2,?,1,'dispatching','message',1,'steer',?,0,0)`)
        .run(serializeSerdeValue(f.body),f.row.original_seal);
      db.exec(`INSERT INTO cdr_async_execution_obligations(question_id,thread_id,origin_job_id,turn_id,channel_id,format_version,revision,
        answer_state,execution_state,admission_state,policy,original_seal,claim_json,original_error,created_at,updated_at)
        SELECT q.id,q.thread_id,q.origin_job_id,q.turn_id,q.channel_id,1,7,'unresolved','unresolved','held','ordinary',q.preparation_json,
          json_object('id',q.id,'runtime_id',q.runtime_id,'generation',q.generation,'thread_id',q.thread_id,'turn_id',q.turn_id,'item_id',q.item_id,
          'origin_job_id',q.origin_job_id,'channel_id',q.channel_id,'owner_user_id',q.owner_user_id,'body',q.body,'chosen',q.chosen,'message_id',q.message_id,'dispatch_mode',q.dispatch_mode),
          'original',0,0 FROM cdr_async_questions q`);
      const snapshot=await captureTerminalHistorySnapshot(path,"target");assert.ok(snapshot);await run(db,path,snapshot);
    }finally{db.close();}
  });
}
function observed(){return {threadId:"target",truncated:false,thread_observation:{thread:{id:"target",status:{type:"idle"}}},goal_observation:{goal:null as unknown},turns:[{id:"turn",status:"completed"}]};}
function insertJob(db:DatabaseSync,id="job",state="pending"):void{
  db.prepare(`INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at,app_server_generation)
    VALUES (?,'target',1,'prompt',1,1,?,0,'[]',0,0,1)`).run(id,state);
}

for(const status of ['idle','notLoaded'])test('Stop leaf settles exact owner under caller transaction: '+status,async()=>fixture(async(db)=>{const value=observed();value.thread_observation.thread.status.type=status;db.exec('BEGIN IMMEDIATE');try{assert.equal(settleStoppedExecutionIn(db,'target','turn',value,'reader',2n),1);assert.equal(db.isTransaction,true);assert.equal(db.prepare('SELECT execution_state FROM cdr_async_execution_obligations').get()!.execution_state,'terminal');}finally{db.exec('ROLLBACK');}assert.equal(db.prepare('SELECT execution_state FROM cdr_async_execution_obligations').get()!.execution_state,'unresolved');}));
test('general historical recovery still rejects notLoaded',async()=>fixture(async(db,path,snapshot)=>{const value=observed();value.thread_observation.thread.status.type='notLoaded';await assert.rejects(settleTerminalHistory(path,snapshot,value,'reader',2n));assert.equal(db.prepare('SELECT execution_state FROM cdr_async_execution_obligations').get()!.execution_state,'unresolved');}));
test('Stop leaf filters other owner turns without settling their question',async()=>fixture(async(db)=>{db.exec('BEGIN IMMEDIATE');try{assert.equal(settleStoppedExecutionIn(db,'target','different-turn',observed(),'reader',2n),0);assert.equal(db.prepare('SELECT execution_state FROM cdr_async_execution_obligations').get()!.execution_state,'unresolved');}finally{db.exec('ROLLBACK');}}));
for(const status of ['active','inProgress'])test('Stop rejects nonterminal metadata or turn: '+status,async()=>fixture(async(db)=>{const value=observed();if(status==='active')value.thread_observation.thread.status.type=status;else value.turns[0]!.status=status;db.exec('BEGIN IMMEDIATE');try{assert.throws(()=>settleStoppedExecutionIn(db,'target','turn',value,'reader',2n));assert.equal(db.isTransaction,true);}finally{db.exec('ROLLBACK');}assert.equal(db.prepare('SELECT execution_state FROM cdr_async_execution_obligations').get()!.execution_state,'unresolved');}));
test('Stop does not bypass active queue and does not cancel it itself',async()=>fixture(async(db)=>{insertJob(db,'new','starting');db.exec('BEGIN IMMEDIATE');try{assert.equal(settleStoppedExecutionIn(db,'target','turn',observed(),'reader',2n),0);assert.equal(db.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()!.n,1);}finally{db.exec('ROLLBACK');}}));

test('Stop settlement preserves publishing hold and confirmed answer',async()=>fixture(async(db)=>{db.exec("UPDATE cdr_async_execution_obligations SET policy='publishing_recovery',answer_state='exact_history_confirmed';BEGIN IMMEDIATE");try{assert.equal(settleStoppedExecutionIn(db,'target','turn',observed(),'reader',2n),1);const row=db.prepare('SELECT admission_state,answer_state FROM cdr_async_execution_obligations').get()!;assert.equal(row.admission_state,'held');assert.equal(row.answer_state,'exact_history_confirmed');}finally{db.exec('ROLLBACK');}}));
test('Stop source verification rejects tampering and caller rollback restores all writes',async()=>fixture(async(db)=>{db.exec("CREATE TRIGGER test_stop_tamper AFTER INSERT ON cdr_async_terminal_settlements BEGIN UPDATE cdr_async_questions SET error='changed' WHERE id='q'; END;BEGIN IMMEDIATE");try{assert.throws(()=>settleStoppedExecutionIn(db,'target','turn',observed(),'reader',2n),/changed its original question/);assert.equal(db.isTransaction,true);}finally{db.exec('ROLLBACK');}assert.equal(db.prepare('SELECT revision FROM cdr_async_execution_obligations').get()!.revision,7);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_async_terminal_settlements').get()!.n,0);}));
