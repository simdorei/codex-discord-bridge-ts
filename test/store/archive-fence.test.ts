import assert from 'node:assert/strict';import {it} from 'node:test';import type {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import type {NewIngress} from '../../src/store/ingress-types.ts';
const request=(id:string,target:string|null,now=1):NewIngress=>({ingressId:id,kind:'message',eventId:BigInt(now+100),applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:BigInt(now+100),payload:{version:1n,content:'!new hi',plan:{Execute:{New:{prompt:'hi'}}}},targetThreadId:target,canonicalOwner:null,now});
async function edit<T>(path:string,fn:(db:DatabaseSync)=>T){const db=await openInitialized(path);try{return fn(db);}finally{db.close();}}
const rows=(path:string)=>edit(path,db=>db.prepare('SELECT * FROM codex_archive_fences ORDER BY target_thread_id').all());
it('one atomic scope uses one UUID and source set semantics; verified fences remain',async()=>storeFixture(async path=>{
 const operation=await state.reserveArchiveScope(path,['b','a','b'],null);assert.match(operation,/^[a-f0-9-]{36}$/);const result=await rows(path);assert.equal(result.length,2);assert.ok(result.every(r=>r.operation_id===operation&&r.phase==='attempted'&&r.own_ingress_id===null));assert.equal(await state.archiveTargetFenced(path,'a'),true);assert.equal(await state.archiveTargetFenced(path,'other'),false);
 await state.markArchiveVerified(path,operation);assert.ok((await rows(path)).every(r=>r.phase==='verified'));await assert.rejects(state.markArchiveVerified(path,operation),/missing attempted/);await assert.rejects(state.releaseRejectedArchive(path,operation),/missing rejected/);assert.equal((await rows(path)).length,2);
}));
it('scope validation occurs before store creation and preserves source whitespace rules',async()=>storeFixture(async path=>{
 for(const scope of [[],[''],[' a'],['a\u0085']])await assert.rejects(state.reserveArchiveScope(path,scope,null),/invalid archive/);await assert.rejects(state.reserveArchiveScope(path,['\ud800'],null),TypeError);assert.equal(existsSync(path),false);
 const op=await state.reserveArchiveScope(path,['\ufeffa'],null);assert.equal(await state.archiveTargetFenced(path,'\ufeffa'),true);await state.releaseRejectedArchive(path,op);
}));
it('unfinished target or unbound ingress blocks scope, while exact own exclusion is narrow',async()=>storeFixture(async path=>{
 await state.admitIngress(path,request('own','a'));await state.admitIngress(path,request('unbound',null,2));await assert.rejects(state.reserveArchiveScope(path,['a'],'own'),/unfinished request unbound/);assert.equal((await rows(path)).length,0);
 await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='completed' WHERE ingress_id='unbound'"));await assert.rejects(state.reserveArchiveScope(path,['a'],null),/unfinished request own/);const op=await state.reserveArchiveScope(path,['a'],'own');assert.equal((await rows(path))[0]!.own_ingress_id,'own');await state.releaseRejectedArchive(path,op);
}));
it('confirmed owned and completed records do not block, unrelated target stays isolated',async()=>storeFixture(async path=>{
 await state.admitIngress(path,request('owned','a'));await state.admitIngress(path,request('other','other',2));await edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='owned',owner_id='job',owner_kind='queue',confirmation_delivered=1 WHERE ingress_id='owned'"));assert.match(await state.reserveArchiveScope(path,['a'],null),/^[a-f0-9-]{36}$/);
}));
it('existing fence anywhere in scope prevents inserting any new scope members',async()=>storeFixture(async path=>{
 const old=await state.reserveArchiveScope(path,['z'],null);await assert.rejects(state.reserveArchiveScope(path,['a','z'],null),/existing archive fence/);assert.equal((await rows(path)).length,1);assert.equal((await rows(path))[0]!.operation_id,old);
}));
it('native insertion failure rolls back earlier scope inserts and leaves no partial reservation',async()=>storeFixture(async path=>{
 await edit(path,db=>db.exec("CREATE TRIGGER reject_second BEFORE INSERT ON codex_archive_fences WHEN NEW.target_thread_id='b' BEGIN SELECT RAISE(ABORT,'fixture archive reject'); END"));await assert.rejects(state.reserveArchiveScope(path,['a','b'],null),/fixture archive reject/);assert.equal((await rows(path)).length,0);
}));
it('late ingress is held and rejected-release does not replay or unhold it',async()=>storeFixture(async path=>{
 const op=await state.reserveArchiveScope(path,['a'],null);await state.admitIngress(path,request('late','a'));const before=await state.getIngress(path,'late');assert.equal(before!.state,'held');assert.equal(before!.phase,'archive_fenced');await state.releaseRejectedArchive(path,op);assert.equal(await state.archiveTargetFenced(path,'a'),false);assert.deepEqual(await state.getIngress(path,'late'),before);assert.equal(await state.beginIngressExecution(path,'late','processing',null,3),false);await assert.rejects(edit(path,db=>db.exec("UPDATE discord_ingress_journal SET state='staged' WHERE ingress_id='late'")),/explicit review/);assert.deepEqual(await state.getIngress(path,'late'),before);
}));
it('release is exact-operation only and cannot release verified or missing reservations',async()=>storeFixture(async path=>{
 const first=await state.reserveArchiveScope(path,['a'],null),second=await state.reserveArchiveScope(path,['b'],null);await state.releaseRejectedArchive(path,first);assert.equal(await state.archiveTargetFenced(path,'a'),false);assert.equal(await state.archiveTargetFenced(path,'b'),true);await assert.rejects(state.releaseRejectedArchive(path,first),/missing rejected/);await state.markArchiveVerified(path,second);await assert.rejects(state.releaseRejectedArchive(path,second),/missing rejected/);
}));
it('queued work and prompt intake block scope while unrelated targets do not',async()=>{
 for(const kind of ['queue','intake'])await storeFixture(async path=>{
  if(kind==='queue')await state.enqueue(path,{jobId:'j',targetThreadId:'busy',channelId:1n,ownerUserId:2n,discordMessageId:3n,appServerGeneration:1n,prompt:'hi',queued:true,ackSent:false,createdAt:1});
  else await edit(path,db=>db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES ('j','busy',1,2,3,'hi',1,0,1,1)"));
  await assert.rejects(state.reserveArchiveScope(path,['free','busy'],null),/has work/);assert.equal((await rows(path)).length,0);assert.match(await state.reserveArchiveScope(path,['free'],null),/^[a-f0-9-]{36}$/);
 });
});
it('competing same-scope reservations have exactly one durable winner',async()=>storeFixture(async path=>{
 const results=await Promise.allSettled([state.reserveArchiveScope(path,['a','b'],null),state.reserveArchiveScope(path,['b','a'],null)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const saved=await rows(path);assert.equal(saved.length,2);assert.equal(new Set(saved.map(r=>r.operation_id)).size,1);
}));
