import test from 'node:test';import assert from 'node:assert/strict';import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';import {admitIngress} from '../../src/store/ingress-admission.ts';import {recoverBoundedPriorRuntimeIngressIn} from '../../src/store/startup-ingress-recovery.ts';import {withStoreTransaction,commitStore} from '../../src/store/owned-scope.ts';
const limits={maxRows:128,maxBytes:1048576};
async function add(path:string,id:string,event:bigint){await admitIngress(path,{ingressId:id,kind:'message',eventId:event,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:event,payload:{version:1n},targetThreadId:'thread',canonicalOwner:null,now:1});}
async function fixture(body:(path:string,db:DatabaseSync)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{await body(path,db);}finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}});}
const recover=(db:DatabaseSync,l=limits)=>withStoreTransaction(db,'IMMEDIATE',()=>commitStore(recoverBoundedPriorRuntimeIngressIn(db,'current',20,l)));
test('bounded startup recovery retains exact prior unowned requests while granting only first-reply ACK recovery to owned input',async()=>fixture(async(path,db)=>{
 for(const [id,event]of[['prior',1n],['current',2n],['owned',3n],['confirmed',4n]] as const)await add(path,id,event);
 db.exec("UPDATE discord_ingress_journal SET runtime_id='current' WHERE ingress_id='current';UPDATE discord_ingress_journal SET state='owned',owner_id='job' WHERE ingress_id='owned';UPDATE discord_ingress_journal SET confirmation_delivered=1 WHERE ingress_id='confirmed';INSERT INTO codex_new_first_replies(job_id,ingress_id,identity_json)VALUES('job','owned','{}')");
 assert.equal(recover(db),1);assert.equal(db.prepare("SELECT state FROM discord_ingress_journal WHERE ingress_id='prior'").get()!.state,'held');assert.equal(db.prepare("SELECT state FROM discord_ingress_journal WHERE ingress_id='current'").get()!.state,'staged');assert.equal(db.prepare("SELECT state FROM discord_ingress_journal WHERE ingress_id='owned'").get()!.state,'owned');assert.equal(db.prepare('SELECT ack_recovery_allowed FROM codex_new_first_replies').get()!.ack_recovery_allowed,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_outbox').get()!.n,1);assert.equal(recover(db),0);
}));
test('acknowledgement candidates count toward whole-operation row budget before any flag or notice changes',async()=>fixture(async(path,db)=>{
 await add(path,'prior',1n);await add(path,'owned',2n);db.exec("UPDATE discord_ingress_journal SET state='owned',owner_id='job' WHERE ingress_id='owned';INSERT INTO codex_new_first_replies(job_id,ingress_id,identity_json)VALUES('job','owned','{}')");
 assert.throws(()=>recover(db,{...limits,maxRows:1}),/row budget/);assert.equal(db.prepare('SELECT ack_recovery_allowed FROM codex_new_first_replies').get()!.ack_recovery_allowed,0);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_outbox').get()!.n,0);assert.equal(recover(db,{...limits,maxRows:2}),1);
}));
test('notice failure rolls back previously staged ACK recovery and all notices as one transaction',async()=>fixture(async(path,db)=>{
 await add(path,'prior',1n);await add(path,'owned',2n);db.exec("UPDATE discord_ingress_journal SET state='owned',owner_id='job' WHERE ingress_id='owned';INSERT INTO codex_new_first_replies(job_id,ingress_id,identity_json)VALUES('job','owned','{}');CREATE TRIGGER reject_notice BEFORE INSERT ON codex_delivery_outbox BEGIN SELECT RAISE(ABORT,'reject notice');END");
 assert.throws(()=>recover(db),/reject notice/);assert.equal(db.prepare('SELECT ack_recovery_allowed FROM codex_new_first_replies').get()!.ack_recovery_allowed,0);assert.equal(db.prepare("SELECT state FROM discord_ingress_journal WHERE ingress_id='prior'").get()!.state,'staged');assert.equal(db.isTransaction,false);
}));
test('current malformed payload is excluded but selected malformed JSON and over-budget evidence reject atomically',async()=>fixture(async(path,db)=>{
 await add(path,'current',1n);db.exec("UPDATE discord_ingress_journal SET runtime_id='current',payload_json='bad json'");assert.equal(recover(db),0);
 await add(path,'prior',2n);assert.throws(()=>recover(db,{...limits,maxBytes:1}));db.exec("UPDATE discord_ingress_journal SET payload_json='bad json' WHERE ingress_id='prior'");assert.throws(()=>recover(db));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_outbox').get()!.n,0);
}));
test('completed action keeps known-completed notice and original payload, never reexecutes',async()=>fixture(async(path,db)=>{
 await add(path,'prior',1n);db.exec("UPDATE discord_ingress_journal SET state='completed',phase='result_recorded',outcome_json='{}'");const before=db.prepare('SELECT payload_json,outcome_json FROM discord_ingress_journal').get();assert.equal(recover(db),1);assert.deepEqual(db.prepare('SELECT payload_json,outcome_json FROM discord_ingress_journal').get(),before);assert.match(db.prepare('SELECT content FROM codex_delivery_outbox').get()!.content as string,/action completed/);
}));
test('borrowed startup recovery rejects invalid configuration without closing or consuming caller transaction',async()=>fixture(async(_path,db)=>{
 assert.throws(()=>recoverBoundedPriorRuntimeIngressIn(db,'current',20,limits),/caller transaction/);db.exec('BEGIN IMMEDIATE');for(const now of [NaN,Infinity,-1])assert.throws(()=>recoverBoundedPriorRuntimeIngressIn(db,'current',now,limits),RangeError);
 let hooks=0;assert.throws(()=>recoverBoundedPriorRuntimeIngressIn(db,'current',1,Object.defineProperty({maxBytes:1},'maxRows',{get(){hooks++;return 1;}}) as never),TypeError);assert.equal(hooks,0);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
}));
