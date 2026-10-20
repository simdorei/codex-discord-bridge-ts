import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {StopAcceptanceBudget,boundedStopEvidenceJson,STOP_ACCEPTANCE_MAX_EVIDENCE_BYTES} from '../../src/store/stop-acceptance-budget.ts';
import {getIngressIn} from '../../src/store/ingress-read.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const scope={target:'T',channel:42n,owner:3n},binding={target:'T',route:'Explicit',command:{Stop:{reference:'T'}}};
async function fixture(run:(path:string,db:DatabaseSync)=>void|Promise<void>,utf16=false){await storeFixture(async path=>{if(utf16){const empty=new DatabaseSync(path);empty.exec("PRAGMA encoding='UTF-16le'; CREATE TABLE encoding_sentinel(value TEXT)");empty.close();}const db=await openInitialized(path);try{await run(path,db);}finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}});}
function job(db:DatabaseSync,id='job',prompt='original',running=false){db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES(?,'T',42,3,1,?,0,1,?,0,?,'[]',1,1)").run(id,prompt,running?'running':'pending',running?'V':null);}
function empty(db:DatabaseSync){for(const table of ['cdr_execution_holds','cdr_stop_revision_receipts','cdr_stop_controls'])assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0);}
function dropIngressTriggers(db:DatabaseSync){for(const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='discord_ingress_journal'").all())db.exec('DROP TRIGGER '+JSON.stringify(row.name));}
const accept=(path:string)=>state.acceptUnresolvedStop(path,scope,binding,null,()=>{});
test('ordinary 64 KiB text boundary succeeds, one byte over refuses before decoder or any write',async()=>{for(const n of [65536,65537])await fixture((path,db)=>{job(db,'job','x'.repeat(n));if(n===65536)assert.equal(accept(path)!.jobs.length,1);else{assert.throws(()=>accept(path),/field byte.*budget/);empty(db);}});});
test('multibyte text and UTF-16 storage are charged conservatively before decode',async()=>{
 await fixture((path,db)=>{job(db,'job','😀'.repeat(16385));assert.throws(()=>accept(path),/field byte.*budget/);empty(db);});
 await fixture((path,db)=>{assert.equal(db.prepare('PRAGMA encoding').get()!.encoding,'UTF-16le');job(db,'job','x'.repeat(16385));assert.throws(()=>accept(path),/field byte.*budget/);empty(db);},true);
});
test('oversized malformed JSON and BLOB storage refuse before parsing',async()=>{for(const mutation of ["UPDATE codex_turn_queue SET baseline_turn_ids='['||printf('%.*c',65537,'x')","UPDATE codex_turn_queue SET prompt=zeroblob(70000)","UPDATE codex_turn_queue SET app_server_generation=zeroblob(70000)"])
 await fixture((path,db)=>{job(db);db.exec(mutation);assert.throws(()=>accept(path),/budget|storage class/);empty(db);});
});
test('one MiB original sum and 128 total originals are independent bounds',async()=>{
 await fixture((path,db)=>{for(let i=0;i<17;i++)job(db,'j'+i,'x'.repeat(64000));assert.throws(()=>accept(path),/cumulative byte.*budget/);empty(db);});
 await fixture((path,db)=>{for(let i=0;i<129;i++)job(db,'j'+i);assert.throws(()=>accept(path),/row.*budget/);empty(db);});
});
test('unowned scan preflights candidate payloads before JSON and skips unrelated corrupt target',async()=>{
 await fixture((path,db)=>{job(db);dropIngressTriggers(db);db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES('bad','message',42,3,?,'executing','processing','T',1,1)").run('['+'x'.repeat(65537));assert.throws(()=>accept(path),/field byte.*budget/);empty(db);});
 await fixture((path,db)=>{job(db);dropIngressTriggers(db);db.exec("INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES('bad','message',42,3,'malformed','executing','processing','unrelated',1,1)");assert.equal(accept(path)!.jobs.length,1);});
 await fixture((path,db)=>{job(db);const q=db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES(?,'message',42,3,'{}','executing','processing','T',1,1)");for(let i=0;i<1025;i++)q.run('unused'+i);assert.throws(()=>accept(path),/row.*budget/);empty(db);});
});
test('generated JSON has a separate four MiB field budget with nested queue escaping bounded during construction',async()=>{
 assert.equal(boundedStopEvidenceJson('x'.repeat(STOP_ACCEPTANCE_MAX_EVIDENCE_BYTES-2)).length,STOP_ACCEPTANCE_MAX_EVIDENCE_BYTES);assert.throws(()=>boundedStopEvidenceJson('x'.repeat(STOP_ACCEPTANCE_MAX_EVIDENCE_BYTES-1)),/generated JSON.*budget/);
 await fixture((path,db)=>{for(let i=0;i<10;i++)job(db,'j'+i,'\u0001'.repeat(64000),i===0);assert.throws(()=>state.acceptRunningStop(path,scope,binding,null,'resident',1n,()=>{}),/generated control JSON.*budget/);empty(db);});
});
test('generated original Stop outcome may exceed ordinary field bound while retaining exact original IDs',async()=>fixture((path,db)=>{
 for(let i=0;i<128;i++)job(db,String(i).padStart(3,'0')+'x'.repeat(600));
 db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,source_message_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES('message:5','message',5,42,3,5,?,'executing','processing','T',1,1)").run(serializeSerdeValue({version:1n,lifecycle_binding:binding,plan:{Execute:binding.command}}));const expected=getIngressIn(db,'message:5')!;
 assert.equal(state.acceptUnresolvedStop(path,scope,binding,expected,()=>{})!.jobs.length,128);assert.ok((db.prepare("SELECT length(outcome_json) AS n FROM discord_ingress_journal WHERE ingress_id='message:5'").get()!.n as number)>65536);assert.equal(getIngressIn(db,'message:5')!.phase,'stop_accepted');
}));
test('cumulative repeated reads and post-write aggregate evidence independently refuse above eight MiB',async()=>{
 await fixture((_path,db)=>{job(db);db.prepare("INSERT INTO cdr_execution_holds(job_id,target_thread_id,reason,evidence_json,created_at) VALUES('job','T','held',?,1)").run('x'.repeat(2*1024*1024));db.exec('BEGIN IMMEDIATE');const budget=new StopAcceptanceBudget(db,'T',42n,'Explicit',null);for(let i=0;i<3;i++)budget.hold('job');assert.throws(()=>budget.hold('job'),/repeated-read byte.*budget/);db.exec('ROLLBACK');});
 await fixture((path,db)=>{for(let i=0;i<3;i++)job(db,'j'+i);db.exec("CREATE TRIGGER oversized AFTER INSERT ON cdr_stop_revisions BEGIN UPDATE cdr_execution_holds SET evidence_json=printf('%.*c',4194304,'x'); END");assert.throws(()=>accept(path),/cumulative byte.*budget/);empty(db);});
});
test('ordinary table requirement rejects views and revision BLOB before materializing aggregate',async()=>{
 await fixture((path,db)=>{job(db);db.exec('ALTER TABLE codex_prompt_intakes RENAME TO source_intakes; CREATE VIEW codex_prompt_intakes AS SELECT * FROM source_intakes');assert.throws(()=>accept(path),/ordinary main tables/);empty(db);});
 await fixture((path,db)=>{job(db);db.exec("INSERT INTO cdr_stop_revision_receipts VALUES('bad','other',zeroblob(100000),'{}')");assert.throws(()=>accept(path),/storage class/);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_execution_holds').get()!.n,0);});
});
test('trigger-expanded fields are rechecked before final decoders and all staged evidence rolls back',async()=>fixture((path,db)=>{job(db);db.exec("CREATE TRIGGER oversized AFTER INSERT ON cdr_stop_revisions BEGIN UPDATE codex_turn_queue SET prompt=printf('%.*c',65537,'x'); END");assert.throws(()=>accept(path),/field byte.*budget/);empty(db);assert.equal(db.prepare('SELECT prompt FROM codex_turn_queue').get()!.prompt,'original');}));
