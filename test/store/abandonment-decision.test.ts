import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {DatabaseSync} from 'node:sqlite';
import {abandonmentStoreFixture} from '../helpers/abandonment-store-fixture.ts';
import {proposeAbandonment,bindAbandonmentDelivery} from '../../src/store/abandonment-proposal.ts';
import {readAbandonmentProposalIn} from '../../src/store/abandonment-proposal-read.ts';
import {recordAbandonmentDecision,readAbandonmentDecisionIn} from '../../src/store/abandonment-decision.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
import {publicationTimeBits,type PublicationProposal} from '../../src/store/publication-codec.ts';
import type {AbandonmentDecision} from '../../src/store/abandonment-codec.ts';
const job='550e8400-e29b-41d4-a716-446655440000',id='a'.repeat(32);
const decisionInput=(decision:AbandonmentDecision='AbandonOnly')=>({proposal_id:id,revision:1n,ingress_id:'interaction:6',decision,now:12});
const click=(decision:AbandonmentDecision)=>({version:1n,work:{Component:{RecoveryAbandonDecision:{proposal_id:id,revision:1n,decision}}}});
const count=(db:DatabaseSync,table:string)=>db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n;
function addClick(db:DatabaseSync,decision:AbandonmentDecision,event=6n){db.prepare(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,created_at,updated_at)
 VALUES(?,'interaction',?,4,1,2,9,?,'app','executing','processing','t',12,12)`).run('interaction:'+event,event,serializeSerdeValue(click(decision)));}
async function fixture(run:(db:DatabaseSync,path:string,p:PublicationProposal)=>void,decision:AbandonmentDecision='AbandonOnly'){
 await abandonmentStoreFixture((db,path)=>{const p=proposeAbandonment(path,{proposal_id:id,job_id:job,ingress_id:'message:5',application_id:4n,now:10,expires_at:20});bindAbandonmentDelivery(path,id,9n,p.review_sha256,11);addClick(db,decision);run(db,path,p);},true,job);
}
function unchanged(db:DatabaseSync){assert.equal(count(db,'codex_turn_queue'),1);assert.equal(count(db,'codex_request_cancellations'),0);assert.equal(count(db,'cdr_recovery_abandonment_decisions'),0);}
test('AbandonOnly atomically removes exactly original Pending and retains exact immutable tombstone',()=>fixture((db,path)=>{
 const receipt=recordAbandonmentDecision(path,decisionInput());assert.equal(receipt.decision,'AbandonOnly');assert.equal(receipt.interaction_id,6n);assert.equal(receipt.recorded_at_bits,publicationTimeBits(12));assert.ok(Object.isFrozen(receipt));
 assert.equal(count(db,'codex_turn_queue'),0);assert.equal(count(db,'cdr_async_recovery_policies'),1);assert.equal(count(db,'codex_request_cancellations'),1);assert.equal(count(db,'cdr_recovery_abandonment_decisions'),1);
 const q=db.prepare('SELECT * FROM codex_request_cancellations');q.setReadBigInts(true);assert.deepEqual({...q.get()},{job_id:job,target_thread_id:'t',channel_id:1n,owner_user_id:2n,discord_message_id:7n,cancelled_at:12});
 assert.deepEqual(readAbandonmentDecisionIn(db,readAbandonmentProposalIn(db,id)),receipt);
 for(const sql of ["DELETE FROM codex_request_cancellations","UPDATE codex_request_cancellations SET cancelled_at=13"])
 assert.throws(()=>db.exec(sql),/immutable|remain non-replayable/);
}));
test('KeepHeld records intent without deleting queue or creating cancellation',()=>fixture((db,path)=>{
 const receipt=recordAbandonmentDecision(path,decisionInput('KeepHeld'));assert.equal(receipt.decision,'KeepHeld');assert.equal(count(db,'codex_turn_queue'),1);assert.equal(count(db,'codex_request_cancellations'),0);assert.equal(count(db,'cdr_async_recovery_policies'),1);
},'KeepHeld'));
test('exact completed interaction replay returns original receipt after expiry and runtime rotation',async()=>{
 for(const decision of ['AbandonOnly','KeepHeld'] as const)await fixture((db,path)=>{
  const original=recordAbandonmentDecision(path,decisionInput(decision));db.exec("UPDATE discord_ingress_journal SET state='completed',phase='done' WHERE ingress_id='interaction:6'; UPDATE codex_app_server_runtime SET runtime_id='next-app'; UPDATE codex_mutation_runtime SET runtime_id='next-wire'");
  assert.deepEqual(recordAbandonmentDecision(path,{...decisionInput(decision),now:99}),original);assert.equal(count(db,'cdr_recovery_abandonment_decisions'),1);
 },decision);
});
test('different interaction cannot reuse consumed decision',()=>fixture((db,path)=>{
 recordAbandonmentDecision(path,decisionInput());addClick(db,'AbandonOnly',8n);assert.throws(()=>recordAbandonmentDecision(path,{...decisionInput(),ingress_id:'interaction:8'}),/consumed by another interaction/);assert.equal(count(db,'cdr_recovery_abandonment_decisions'),1);
}));
test('conflicting choice cannot overwrite even the same interaction receipt',()=>fixture((db,path)=>{
 recordAbandonmentDecision(path,decisionInput('KeepHeld'));
 db.prepare("UPDATE discord_ingress_journal SET payload_json=? WHERE ingress_id='interaction:6'").run(serializeSerdeValue(click('AbandonOnly')));
 assert.throws(()=>recordAbandonmentDecision(path,decisionInput()),/consumed by another interaction/);assert.equal(count(db,'codex_turn_queue'),1);assert.equal(count(db,'codex_request_cancellations'),0);
},'KeepHeld'));
test('fresh invalid actor, message, custody, runtime and envelope cause no mutation',async()=>{
 for(const sql of ["owner_user_id=8","source_message_id=8","owner_kind='job'","runtime_id='other'","state='completed'","payload_json='{}'"])
 await fixture((db,path)=>{db.exec("UPDATE discord_ingress_journal SET "+sql+" WHERE ingress_id='interaction:6'");assert.throws(()=>recordAbandonmentDecision(path,decisionInput()));unchanged(db);});
});
test('fresh expired or superseded decisions are rejected before any disposition',async()=>{
 await fixture((db,path)=>{assert.throws(()=>recordAbandonmentDecision(path,{...decisionInput(),now:20}),/expired/);unchanged(db);});
 await fixture((db,path)=>{proposeAbandonment(path,{proposal_id:'b'.repeat(32),job_id:job,ingress_id:'message:5',application_id:4n,now:10,expires_at:20});assert.throws(()=>recordAbandonmentDecision(path,decisionInput()),/superseded/);unchanged(db);});
});
test('invalid revision and finite host time reject before opening database',()=>fixture((_db,path)=>{
 for(const now of [NaN,Infinity,-1])assert.throws(()=>recordAbandonmentDecision(path+'.absent',{...decisionInput(),now}),/invalid decision/);
 assert.throws(()=>recordAbandonmentDecision(path+'.absent',{...decisionInput(),revision:0n}),/invalid decision/);
}));
test('ignored decision, cancellation or queue deletion rolls back the whole transaction',async()=>{
 for(const [name,sql] of [['decision',"BEFORE INSERT ON cdr_recovery_abandonment_decisions"],['cancel',"BEFORE INSERT ON codex_request_cancellations"],['queue',"BEFORE DELETE ON codex_turn_queue"]])
 await fixture((db,path)=>{db.exec(`CREATE TRIGGER sabotage_${name} ${sql} BEGIN SELECT RAISE(IGNORE); END`);assert.throws(()=>recordAbandonmentDecision(path,decisionInput()),/ignored|removal did not apply/);unchanged(db);assert.equal(db.isTransaction,false);});
});
test('existing cancellation guard blocks original queue mutation and rolls back all effects',()=>fixture((db,path)=>{
 db.exec("CREATE TRIGGER sabotage_mutation AFTER INSERT ON codex_request_cancellations BEGIN UPDATE codex_turn_queue SET prompt='changed'; END");
 assert.throws(()=>recordAbandonmentDecision(path,decisionInput()),/request was cancelled by its original sender; no automatic retry/);unchanged(db);assert.equal(db.prepare('SELECT prompt FROM codex_turn_queue').get()!.prompt,'prompt');
}));
test('change to another lifecycle context during delete rolls back cancellation and deletion',()=>fixture((db,path)=>{
 db.exec("CREATE TRIGGER sabotage_context AFTER DELETE ON codex_turn_queue BEGIN UPDATE mirror_threads SET thread_title='changed'; END");
 assert.throws(()=>recordAbandonmentDecision(path,decisionInput()),/another request or a lifecycle barrier/);unchanged(db);assert.equal(db.prepare('SELECT thread_title FROM mirror_threads').get()!.thread_title,'title');
}));
test('stored AbandonOnly receipt without applied tombstone fails closed',()=>fixture((db)=>{
 db.prepare('INSERT INTO cdr_recovery_abandonment_decisions VALUES(?,1,?,6,?,?)').run(id,'interaction:6','abandon_only',publicationTimeBits(12).toString());
 assert.throws(()=>readAbandonmentDecisionIn(db,readAbandonmentProposalIn(db,id)),/exact non-executable tombstone/);
}));
test('stored timestamp syntax and validity are checked independently of typed receipt',async()=>{
 for(const bits of ['12\n','-1','18446744073709551616',publicationTimeBits(NaN).toString(),publicationTimeBits(20).toString()])
 await fixture(db=>{db.prepare('INSERT INTO cdr_recovery_abandonment_decisions VALUES(?,1,?,6,?,?)').run(id,'interaction:6','keep_held',bits);assert.throws(()=>readAbandonmentDecisionIn(db,readAbandonmentProposalIn(db,id)),/timestamp/);},'KeepHeld');
 await fixture(db=>{db.prepare('INSERT INTO cdr_recovery_abandonment_decisions VALUES(?,1,?,6,?,?)').run(id,'interaction:6','keep_held','+'+publicationTimeBits(12));assert.equal(readAbandonmentDecisionIn(db,readAbandonmentProposalIn(db,id))!.recorded_at_bits,publicationTimeBits(12));},'KeepHeld');
});

test('context mutation during cancellation is detected before Pending removal and rolled back',()=>fixture((db,path)=>{
 db.exec("CREATE TRIGGER sabotage_before_remove AFTER INSERT ON codex_request_cancellations BEGIN UPDATE mirror_threads SET thread_title='changed'; END");
 assert.throws(()=>recordAbandonmentDecision(path,decisionInput()),/original evidence changed during disposition/);unchanged(db);assert.equal(db.prepare('SELECT thread_title FROM mirror_threads').get()!.thread_title,'title');
}));
