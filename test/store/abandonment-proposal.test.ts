import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {abandonmentStoreFixture} from '../helpers/abandonment-store-fixture.ts';
import {proposeAbandonment,bindAbandonmentDelivery} from '../../src/store/abandonment-proposal.ts';
import {readAbandonmentProposalIn,readDeliveredAbandonmentIn,latestAbandonmentRevisionIn} from '../../src/store/abandonment-proposal-read.ts';
import {isRustUuidText} from '../../src/core/rust-uuid-text.ts';
import {publicationDigest} from '../../src/store/publication-codec.ts';
const job='550e8400-e29b-41d4-a716-446655440000',id='a'.repeat(32);
const input=()=>({proposal_id:id,job_id:job,ingress_id:'message:5',application_id:4n,now:10,expires_at:20});
const fixture=(run:(db:DatabaseSync,path:string)=>void)=>abandonmentStoreFixture(run,true,job);
const count=(db:DatabaseSync,table='cdr_recovery_abandonment_proposals')=>db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n;
test('uuid1.26 exact acceptance includes simple, braced and case-sensitive URN without whitespace',()=>{
 for(const value of [job,job.toUpperCase(),job.replaceAll('-',''),`{${job}}`,`urn:uuid:${job}`,'0'.repeat(32)])assert.equal(isRustUuidText(value),true,value);
 for(const value of ['',job+'\n',' '+job,`URN:UUID:${job}`,`{${job.replaceAll('-','')}}`,`urn:uuid:${job.replaceAll('-','')}`,job.replace('4','g'),null,3])assert.equal(isRustUuidText(value),false,String(value));
});
test('proposal stores exact review once, retains original request and repeats idempotently',()=>fixture((db,path)=>{
 const p=proposeAbandonment(path,input());assert.equal(p.revision,1n);assert.equal(p.review_text,`Abandon saved request only?\nRequest: ${job}\nThread: t\nProposal revision: 1\n\nThis one saved request will be permanently cancelled and never replayed.\nThe thread remains held; this does not enable new requests, stop the original execution, withdraw Stop/Archive, unarchive a thread, or cancel published posts or schedules.\nChoose Abandon saved request only or Keep held.\nExpires (host epoch seconds): 20`);
 assert.equal(p.review_sha256,publicationDigest(p.review_text));assert.deepEqual(proposeAbandonment(path,input()),p);assert.equal(count(db),1);
 assert.equal(db.prepare('SELECT state FROM codex_turn_queue').get()!.state,'pending');assert.equal(count(db,'codex_request_cancellations'),0);assert.equal(count(db,'cdr_async_recovery_policies'),1);
 assert.equal(readAbandonmentProposalIn(db,id).source_ingress,'message:5');assert.equal(db.isTransaction,false);
}));
test('identity reuse with changed time or evidence rolls back without replacing original',()=>fixture((db,path)=>{
 const p=proposeAbandonment(path,input());assert.throws(()=>proposeAbandonment(path,{...input(),now:11}),/identity was reused/);
 db.exec("UPDATE codex_turn_queue SET prompt='different'");assert.throws(()=>proposeAbandonment(path,input()),/identity was reused/);assert.equal(count(db),1);assert.deepEqual(readAbandonmentProposalIn(db,id).proposal,p);
}));
test('new proposal uses next exact revision and old proposal can no longer bind',()=>fixture((db,path)=>{
 const first=proposeAbandonment(path,input()),second=proposeAbandonment(path,{...input(),proposal_id:'b'.repeat(32)});assert.equal(second.revision,2n);assert.equal(latestAbandonmentRevisionIn(db,job),2n);
 assert.throws(()=>bindAbandonmentDelivery(path,id,9n,first.review_sha256,11),/superseded/);assert.equal(count(db,'cdr_recovery_abandonment_deliveries'),0);
}));
test('invalid input is rejected before opening or creating missing database',()=>fixture((_db,path)=>{
 const missing=path+'.missing';for(const change of [{job_id:'bad'},{proposal_id:'A'.repeat(32)},{application_id:0n},{now:NaN},{now:-1},{expires_at:10},{expires_at:611},{ingress_id:''},{ingress_id:'가'.repeat(86)}])
 assert.throws(()=>proposeAbandonment(missing,{...input(),...change}),/invalid proposal identity/);
 assert.throws(()=>proposeAbandonment(missing,input()));assert.equal(existsSync(missing),false);
}));
test('source custody refusal prevents storing a proposal',()=>fixture((db,path)=>{
 db.exec("UPDATE discord_ingress_journal SET state='completed',phase='done'");assert.throws(()=>proposeAbandonment(path,input()),/processing custody/);assert.equal(count(db),0);
}));
test('binding is exact and idempotent; conflicting delivery and body are refused',()=>fixture((db,path)=>{
 const p=proposeAbandonment(path,input());bindAbandonmentDelivery(path,id,9n,p.review_sha256,11);bindAbandonmentDelivery(path,id,9n,p.review_sha256,11);
 assert.deepEqual(readDeliveredAbandonmentIn(db,id,1n),{proposal:p,message_id:9n});assert.equal(count(db,'cdr_recovery_abandonment_deliveries'),1);
 assert.throws(()=>bindAbandonmentDelivery(path,id,10n,p.review_sha256,11),/bound elsewhere/);assert.throws(()=>bindAbandonmentDelivery(path,id,9n,'0'.repeat(64),11),/body differs/);
 assert.throws(()=>bindAbandonmentDelivery(path,id,0n,p.review_sha256,11),/invalid source message/);
}));
test('expiry and changed snapshot block delivery without partial binding',()=>fixture((db,path)=>{
 const p=proposeAbandonment(path,input());assert.throws(()=>bindAbandonmentDelivery(path,id,9n,p.review_sha256,20),/expired/);assert.equal(count(db,'cdr_recovery_abandonment_deliveries'),0);
 db.exec("UPDATE codex_turn_queue SET prompt='changed'");assert.throws(()=>bindAbandonmentDelivery(path,id,9n,p.review_sha256,11),/evidence changed/);assert.equal(count(db,'cdr_recovery_abandonment_deliveries'),0);
}));
test('insert ignored by a trigger causes rollback rather than claimed success',()=>fixture((db,path)=>{
 db.exec("CREATE TRIGGER sabotage_proposal BEFORE INSERT ON cdr_recovery_abandonment_proposals BEGIN SELECT RAISE(IGNORE); END");
 assert.throws(()=>proposeAbandonment(path,input()),/proposal was not stored/);assert.equal(count(db),0);assert.equal(db.isTransaction,false);
}));
