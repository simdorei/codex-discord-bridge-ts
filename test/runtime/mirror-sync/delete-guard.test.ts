import {openInitialized} from '../../../src/store/owned-driver.ts';
import {OwnedWorkerSlot} from '../../../src/runtime/owned-worker-slot.ts';
import test from 'node:test';import assert from 'node:assert/strict';import * as http from 'node:http';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {NativeMirrorStore} from '../../../src/runtime/mirror-sync/store-native.ts';
import {MirrorDeletionGuard} from '../../../src/runtime/mirror-sync/delete-guard.ts';
import {DiscordMirrorDeletionTransport,mirrorDeleteRejectedStatus} from '../../../src/runtime/mirror-sync/delete-http.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {MirrorCleanupProtectedError} from '../../../src/runtime/cleanup-refusal.ts';
const fresh=()=>new AbortController().signal;
async function fixture(status:number,body:string,run:(store:NativeMirrorStore,guard:MirrorDeletionGuard,calls:()=>number,path:string)=>Promise<void>){
 await storeFixture(async path=>{
  let calls=0;const server=http.createServer((q,r)=>{calls++;q.resume();r.writeHead(status);r.end(body);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');
  const client=await DiscordChannelClient.create({token:null,report:()=>{},testOrigin:`http://127.0.0.1:${a.port}/api/v10/`}),store=new NativeMirrorStore(path),guard=new MirrorDeletionGuard(store,new DiscordMirrorDeletionTransport(client));
  try{await run(store,guard,()=>calls,path);}finally{await client.close();server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
 });
}
test('successful deletion completes exact native fence before reporting success',()=>fixture(204,'',async(store,guard,calls)=>{
 await guard.ensureReconciled(fresh());await guard.deleteGuarded(3n,null,fresh());assert.equal(calls(),1);assert.equal(await store.execute({kind:'CleanupPhase',args:[3n]}),'deleted');await guard.ensureReconciled(fresh());
}));
test('only genuine authoritative rejection releases native cleanup fence',()=>fixture(403,'{"code":0,"message":"denied"}',async(store,guard,calls)=>{
 await assert.rejects(guard.deleteGuarded(3n,null,fresh()),e=>mirrorDeleteRejectedStatus(e)===403);assert.equal(calls(),1);assert.equal(await store.execute({kind:'CleanupPhase',args:[3n]}),null);await guard.ensureReconciled(fresh());
}));
for(const [status,body] of [[500,'{"code":0,"message":"failed"}'],[403,'malformed']] as const)test('unknown deletion retains fence and prohibits reconciliation '+status,()=>fixture(status,body,async(store,guard,calls)=>{
 await assert.rejects(guard.deleteGuarded(3n,null,fresh()),/durable fence retained/);assert.equal(await store.execute({kind:'CleanupPhase',args:[3n]}),'deleting');await assert.rejects(guard.ensureReconciled(fresh()),/manual reconciliation/);await assert.rejects(guard.deleteGuarded(3n,null,fresh()));assert.equal(calls(),1);
}));
test('pre-delete protection dispatches no HTTP and leaves no new fence',()=>fixture(204,'',async(store,guard,calls)=>{
 await store.execute({kind:'BeginCategory',args:[1n,null]});await assert.rejects(guard.deleteGuarded(3n,null,fresh()),MirrorCleanupProtectedError);assert.equal(calls(),0);assert.equal(await store.execute({kind:'CleanupPhase',args:[3n]}),null);
}));
test('missing room is tombstoned without HTTP; existing unknown fence cannot become deleted',()=>fixture(204,'',async(store,guard,calls)=>{
 await guard.fenceMissingRoom(3n,null,fresh());await guard.fenceMissingRoom(3n,null,fresh());assert.equal(await store.execute({kind:'CleanupPhase',args:[3n]}),'deleted');assert.equal(calls(),0);
 await store.execute({kind:'BeginCleanup',args:[4n,null,1]});await assert.rejects(guard.fenceMissingRoom(4n,null,fresh()),/mapping retained/);assert.equal(await store.execute({kind:'CleanupPhase',args:[4n]}),'deleting');
}));
test('preaborted and invalid identity requests produce no HTTP',()=>fixture(204,'',async(_store,guard,calls)=>{
 const c=new AbortController(),reason=new Error('cancel');c.abort(reason);await assert.rejects(guard.deleteGuarded(3n,null,c.signal),e=>e===reason);
 for(const id of [0n,-1n,1n<<63n])await assert.rejects(guard.deleteGuarded(id,null,fresh()));assert.equal(calls(),0);
}));
test('HTTP success with failed completion keeps durable unknown fence and never repeats HTTP',()=>fixture(204,'',async(store,guard,calls,path)=>{
 const db=await openInitialized(path);try{db.exec("CREATE TRIGGER reject_complete BEFORE UPDATE OF phase ON cdr_cleanup_fences BEGIN SELECT RAISE(ABORT,'completion failed');END");}finally{db.close();}
 await assert.rejects(guard.deleteGuarded(3n,null,fresh()));assert.equal(calls(),1);assert.equal(await store.execute({kind:'CleanupPhase',args:[3n]}),'deleting');
 await assert.rejects(guard.ensureReconciled(fresh()));await assert.rejects(guard.deleteGuarded(3n,null,fresh()));assert.equal(calls(),1);
}));
test('lost native begin acknowledgement prevents HTTP even when fence committed',async t=>fixture(204,'',async(store,guard,calls)=>{
 const original=OwnedWorkerSlot.prototype.run;
 const mock=t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<OwnedWorkerSlot['run']>){return original.apply(this,args).then(()=>{throw new Error('lost acknowledgement');});});
 await assert.rejects(guard.deleteGuarded(3n,null,fresh()));mock.mock.restore();assert.equal(calls(),0);assert.equal(await store.execute({kind:'CleanupPhase',args:[3n]}),'deleting');
}));
