import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {DatabaseSync} from 'node:sqlite';
import {abandonmentStoreFixture as fixture} from '../helpers/abandonment-store-fixture.ts';
import {captureAbandonmentSnapshotIn} from '../../src/store/abandonment-snapshot.ts';
import {readOptionalAbandonmentProposalIn,readAbandonmentProposalIn,latestAbandonmentRevisionIn,verifyAbandonmentFreshIn,readDeliveredAbandonmentIn,requireAbandonmentActor,requireAbandonmentDatabase} from '../../src/store/abandonment-proposal-read.ts';
import {serializeStoredAbandonmentProposal,type StoredAbandonmentProposal} from '../../src/store/abandonment-codec.ts';
import {publicationDigest,publicationTimeBits} from '../../src/store/publication-codec.ts';
const id='a'.repeat(32);
function make(db:DatabaseSync,path:string):StoredAbandonmentProposal {
 db.exec('BEGIN');const snapshot=captureAbandonmentSnapshotIn(db,path,'job','message:5',true).evidence;db.exec('COMMIT');
 return {version:1n,proposal:{id,revision:1n,job_id:'job',thread_id:'t',owner_user_id:2n,channel_id:1n,application_id:4n,
  created_at_bits:publicationTimeBits(10),expires_at_bits:publicationTimeBits(20),review_text:'review',review_sha256:publicationDigest('review')},source_ingress:'message:5',snapshot};
}
function insert(db:DatabaseSync,s:StoredAbandonmentProposal,options:{hash?:string;owner?:bigint;raw?:string}={}){
 const p=s.proposal,raw=options.raw??serializeStoredAbandonmentProposal(s);
 db.prepare('INSERT INTO cdr_recovery_abandonment_proposals VALUES(?,?,?,?,?,?,?,?,?,?)').run(p.id,1n,p.revision,p.job_id,p.thread_id,options.owner??p.owner_user_id,p.channel_id,p.application_id,raw,options.hash??publicationDigest(raw));
}
test('read returns immutable exact seal and leaves query-only caller transaction intact',()=>fixture((db,path)=>{
 const s=make(db,path);insert(db,s);db.exec('BEGIN; PRAGMA query_only=ON');assert.deepEqual(readAbandonmentProposalIn(db,id),s);assert.equal(latestAbandonmentRevisionIn(db,'job'),1n);
 assert.ok(Object.isFrozen(readAbandonmentProposalIn(db,id).snapshot));assert.equal(db.isTransaction,true);assert.doesNotThrow(()=>verifyAbandonmentFreshIn(db,path,s,10));db.exec('ROLLBACK');
}));
test('invalid ID, missing row and incomplete compatibility are distinct failures',()=>fixture((db)=>{
 assert.throws(()=>readOptionalAbandonmentProposalIn(db,'bad'),/invalid proposal identity/);assert.equal(readOptionalAbandonmentProposalIn(db,id),null);assert.equal(latestAbandonmentRevisionIn(db,'none'),0n);
 assert.throws(()=>readAbandonmentProposalIn(db,id),/missing or oversized/);db.exec('DROP TRIGGER cdr_recovery_abandonment_proposal_immutable');assert.throws(()=>readOptionalAbandonmentProposalIn(db,id),/incomplete abandonment/);
}));
test('seal digest, independent SQL identity and review digest all require exact equality',async()=>{
 for(const mode of ['hash','owner','review'])await fixture((db,path)=>{const s=make(db,path);if(mode==='review')(s.proposal as any).review_text='changed';insert(db,s,mode==='hash'?{hash:'0'.repeat(64)}:mode==='owner'?{owner:8n}:{});assert.throws(()=>readAbandonmentProposalIn(db,id),/immutable private seal/);});
});
test('time bit fields reject nonfinite, negative, nonincreasing and excessive lifetime',async()=>{
 for(const [created,expires] of [[NaN,20],[10,Infinity],[-1,20],[10,10],[10,611]])await fixture((db,path)=>{
  const s=make(db,path);(s.proposal as any).created_at_bits=publicationTimeBits(created!);(s.proposal as any).expires_at_bits=publicationTimeBits(expires!);insert(db,s);assert.throws(()=>readAbandonmentProposalIn(db,id),/immutable private seal/);
 });
});
test('freshness includes start-inclusive/end-exclusive bounds and exact native evidence',()=>fixture((db,path)=>{
 const s=make(db,path);insert(db,s);db.exec('BEGIN');for(const now of [NaN,Infinity,9,20,21])assert.throws(()=>verifyAbandonmentFreshIn(db,path,s,now),/expired, superseded/);
 assert.doesNotThrow(()=>verifyAbandonmentFreshIn(db,path,s,19.999));db.exec("UPDATE codex_turn_queue SET prompt='changed'");assert.throws(()=>verifyAbandonmentFreshIn(db,path,s,11),/exact evidence changed/);db.exec('ROLLBACK');
 db.exec('BEGIN');assert.doesNotThrow(()=>verifyAbandonmentFreshIn(db,path,s,11));
}));
test('higher revision supersedes prior seal without changing its historical read',()=>fixture((db,path)=>{
 const first=make(db,path);insert(db,first);const second=structuredClone(first);(second.proposal as any).id='b'.repeat(32);(second.proposal as any).revision=2n;insert(db,second);
 db.exec('BEGIN');assert.deepEqual(readAbandonmentProposalIn(db,id),first);assert.throws(()=>verifyAbandonmentFreshIn(db,path,first,11),/superseded/);assert.doesNotThrow(()=>verifyAbandonmentFreshIn(db,path,second,11));
}));
test('canonical database mismatch and missing database cannot pass identity check',()=>fixture((db,path)=>{
 const s=make(db,path);const wrong=structuredClone(s);(wrong.snapshot as any).context.database=path+'.other';assert.throws(()=>requireAbandonmentDatabase(path,wrong),/another database installation/);
 assert.throws(()=>requireAbandonmentDatabase(path+'.absent',s),/database identity is unavailable/);
}));
test('delivered proposal retains exact revision, body and actor tuple without granting freshness',()=>fixture((db,path)=>{
 const s=make(db,path);insert(db,s);assert.throws(()=>readDeliveredAbandonmentIn(db,id,1n),/Query returned no rows/);
 db.prepare('INSERT INTO cdr_recovery_abandonment_deliveries VALUES(?,1,9,?)').run(id,s.proposal.review_sha256);
 const delivered=readDeliveredAbandonmentIn(db,id,1n);assert.equal(delivered.message_id,9n);assert.ok(Object.isFrozen(delivered));assert.doesNotThrow(()=>requireAbandonmentActor(delivered,4n,1n,2n,9n));
 for(const tuple of [[0n,1n,2n,9n],[4n,8n,2n,9n],[4n,1n,8n,9n],[4n,1n,2n,8n]])assert.throws(()=>requireAbandonmentActor(delivered,...tuple as [bigint,bigint,bigint,bigint]),/authenticated delivery/);
 assert.throws(()=>readDeliveredAbandonmentIn(db,id,2n),/displayed proposal identity/);
}));
test('different delivered body hash fails even when proposal revision is correct',()=>fixture((db,path)=>{
 const s=make(db,path);insert(db,s);db.prepare('INSERT INTO cdr_recovery_abandonment_deliveries VALUES(?,1,9,?)').run(id,'0'.repeat(64));assert.throws(()=>readDeliveredAbandonmentIn(db,id,1n),/displayed proposal identity/);
}));
