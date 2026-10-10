import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {abandonmentStoreFixture} from '../helpers/abandonment-store-fixture.ts';
import {proposeAbandonment,bindAbandonmentDelivery} from '../../src/store/abandonment-proposal.ts';
import {recordAbandonmentDecision} from '../../src/store/abandonment-decision.ts';
import {abandonmentCommandTarget,authorizeAbandonmentDecision,deliveredAbandonmentProposal,abandonmentDecisionStatus} from '../../src/store/abandonment-routing.ts';
import {usingExistingReadOnlyStore,withStoreTransaction,commitStore} from '../../src/store/owned-scope.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const job='550e8400-e29b-41d4-a716-446655440000',id='a'.repeat(32);
const route=()=>({proposal_id:id,revision:1n,interaction_id:6n,application_id:4n,channel_id:1n,owner_user_id:2n,source_message_id:9n,decision:'AbandonOnly' as const,now:12});
async function fixture(run:(db:DatabaseSync,path:string)=>void){await abandonmentStoreFixture((db,path)=>{
 const p=proposeAbandonment(path,{proposal_id:id,job_id:job,ingress_id:'message:5',application_id:4n,now:10,expires_at:20});bindAbandonmentDelivery(path,id,9n,p.review_sha256,11);run(db,path);
},true,job);}
function apply(db:DatabaseSync,path:string){db.prepare(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,created_at,updated_at)
 VALUES('interaction:6','interaction',6,4,1,2,9,?,'app','executing','processing','t',12,12)`).run(serializeSerdeValue({version:1n,work:{Component:{RecoveryAbandonDecision:{proposal_id:id,revision:1n,decision:'AbandonOnly'}}}}));
 return recordAbandonmentDecision(path,{proposal_id:id,revision:1n,ingress_id:'interaction:6',decision:'AbandonOnly',now:12});}
test('central read-only scope uses 100ms timeout, forbids writes, closes success and failure handles',()=>fixture((_db,path)=>{
 let handle:DatabaseSync|undefined;assert.equal(usingExistingReadOnlyStore(path,db=>{handle=db;assert.equal(db.prepare('PRAGMA busy_timeout').get()!.timeout,100);assert.throws(()=>db.exec('CREATE TABLE forbidden(v)'));return 42;}),42);assert.equal(handle!.isOpen,false);
 const sentinel={};assert.throws(()=>usingExistingReadOnlyStore(path,db=>{handle=db;throw sentinel;}),e=>e===sentinel);assert.equal(handle!.isOpen,false);
 let called=0;assert.throws(()=>usingExistingReadOnlyStore(path,async()=>{called++;}),/synchronous/);assert.equal(called,0);
 assert.equal(usingExistingReadOnlyStore(path,db=>withStoreTransaction(db,'DEFERRED',()=>commitStore(7))),7);
}));
test('missing read-only database is never created and unsupported schema is not migrated',()=>fixture((_db,path)=>{
 assert.throws(()=>abandonmentCommandTarget(path+'.missing',job,1n,2n));assert.equal(existsSync(path+'.missing'),false);
 _db.exec('DROP TRIGGER cdr_recovery_abandonment_proposal_immutable');assert.throws(()=>abandonmentCommandTarget(path,job,1n,2n),/incomplete abandonment/);
 assert.equal(_db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='cdr_recovery_abandonment_proposal_immutable'").get()!.n,0);
}));
test('command route resolves only exact canonical job, original owner and channel',()=>fixture((_db,path)=>{
 assert.equal(abandonmentCommandTarget(path,job,1n,2n),'t');
 for(const bad of [job.toUpperCase(),job.replaceAll('-',''),`{${job}}`,`urn:uuid:${job}`,job+'\n'])assert.throws(()=>abandonmentCommandTarget(path,bad,1n,2n),/exact job/);
 assert.throws(()=>abandonmentCommandTarget(path,job,8n,2n),/Query returned no rows/);assert.throws(()=>abandonmentCommandTarget(path,job,1n,8n),/Query returned no rows/);
}));
test('command route rejects ineligible queue fields and ambiguous original mapping',async()=>{
 for(const change of ["turn_id='started'","goal_waiting=1","discord_message_id=NULL","app_server_generation=0"])
 await fixture((db,path)=>{db.exec('UPDATE codex_turn_queue SET '+change);assert.throws(()=>abandonmentCommandTarget(path,job,1n,2n),/Query returned no rows/);});
 await fixture((db,path)=>{db.exec("INSERT INTO mirror_threads VALUES('other','p','title',10,1,1)");assert.throws(()=>abandonmentCommandTarget(path,job,1n,2n),/exact original mapping/);});
});
test('new decision authenticates before saved click exists using fresh proposal only',()=>fixture((db,path)=>{
 const before=readFileSync(path);const delivered=authorizeAbandonmentDecision(path,route());assert.equal(delivered.message_id,9n);assert.equal(delivered.proposal.id,id);
 assert.equal(db.prepare("SELECT count(*) AS n FROM discord_ingress_journal WHERE kind='interaction'").get()!.n,0);assert.equal(abandonmentDecisionStatus(path,id,1n),null);assert.deepEqual(readFileSync(path),before);
}));
test('wrong event, actor, displayed message or revision cannot authorize decision',()=>fixture((_db,path)=>{
 for(const changed of [{interaction_id:0n},{application_id:8n},{owner_user_id:8n},{channel_id:8n},{source_message_id:8n},{revision:2n},{now:NaN},{now:-1}])assert.throws(()=>authorizeAbandonmentDecision(path,{...route(),...changed}));
}));
test('fresh expiry and exact evidence changes are refused',()=>fixture((db,path)=>{
 assert.throws(()=>authorizeAbandonmentDecision(path,{...route(),now:20}),/expired/);db.exec("UPDATE codex_turn_queue SET prompt='changed'");assert.throws(()=>authorizeAbandonmentDecision(path,route()),/exact evidence changed/);
 assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_recovery_abandonment_decisions').get()!.n,0);
}));
test('historical delivered identity survives expiry but is not fresh consent',()=>fixture((_db,path)=>{
 assert.equal(deliveredAbandonmentProposal(path,id,1n).message_id,9n);assert.throws(()=>authorizeAbandonmentDecision(path,{...route(),now:99}),/expired/);
 assert.throws(()=>deliveredAbandonmentProposal(path,id,0n),/displayed proposal/);assert.throws(()=>abandonmentDecisionStatus(path,id,2n),/status revision differs/);
}));
test('consumed exact event can authorize historical route and read durable status after expiry',()=>fixture((db,path)=>{
 const receipt=apply(db,path);db.exec("UPDATE discord_ingress_journal SET state='completed',phase='done' WHERE ingress_id='interaction:6'");
 assert.equal(authorizeAbandonmentDecision(path,{...route(),now:99}).proposal.id,id);assert.deepEqual(abandonmentDecisionStatus(path,id,1n),receipt);
 assert.throws(()=>authorizeAbandonmentDecision(path,{...route(),interaction_id:8n,now:99}),/consumed by another interaction/);
 assert.throws(()=>authorizeAbandonmentDecision(path,{...route(),decision:'KeepHeld',now:99}),/consumed by another interaction/);
}));
test('historical route still requires mapping and exact saved actor',async()=>{
 await fixture((db,path)=>{apply(db,path);db.exec('DELETE FROM mirror_threads');assert.throws(()=>authorizeAbandonmentDecision(path,{...route(),now:99}),/exact original mapping/);});
 await fixture((db,path)=>{apply(db,path);db.exec("UPDATE discord_ingress_journal SET owner_user_id=8 WHERE ingress_id='interaction:6'");assert.throws(()=>authorizeAbandonmentDecision(path,{...route(),now:99}),/saved interaction/);});
});

import {StateAccessFacade} from '../../src/store/state-access-facade.ts';
test('central state facade preserves exact abandonment API references without wrapper drift',()=>{
 for(const [key,value] of Object.entries({proposeAbandonment,bindAbandonmentDelivery,recordAbandonmentDecision,abandonmentCommandTarget,authorizeAbandonmentDecision,deliveredAbandonmentProposal,abandonmentDecisionStatus}))assert.equal((StateAccessFacade as any)[key],value);
});
