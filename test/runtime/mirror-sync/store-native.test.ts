import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {NativeMirrorStore,NativeMirrorStoreUnknownError} from '../../../src/runtime/mirror-sync/store-native.ts';
import {captureMirrorStoreRequest,type MirrorStoreRequest} from '../../../src/runtime/mirror-sync/store-native-protocol.ts';
import {ownContainerReceipt,type MirrorContainerReceipt} from '../../../src/store/mirror-container-creation.ts';
import {MirrorCleanupProtectedError} from '../../../src/runtime/cleanup-refusal.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
async function init(path:string){const db=await openInitialized(path);db.close();}
function records(path:string){const db=new DatabaseSync(path);try{return db.prepare('SELECT kind,scope_key,phase,channel_id FROM cdr_mirror_container_creations ORDER BY kind,scope_key').all();}finally{db.close();}}
test('native category initialization, confirmation and binding remain in one fixed database',()=>storeFixture(async path=>{
 const w=new NativeMirrorStore(path);assert.equal(await w.execute({kind:'CategoryReceipt',args:[1n]}),null);assert.equal(existsSync(path),true);
 const a=ownContainerReceipt(await w.execute({kind:'BeginCategory',args:[1n,null]}) as MirrorContainerReceipt);assert.equal(a.phase,'attempted');assert.equal(ownedWorkerUsage().Control,0);
 const c=ownContainerReceipt(await w.execute({kind:'ConfirmContainer',args:[a,3n]}) as MirrorContainerReceipt);await w.execute({kind:'BindCategory',args:[c]});assert.equal(records(path)[0]?.phase,'bound');assert.throws(()=>w.assertPath(path+'.other'),/another database/);
}));
test('native project snapshot, creation and mapping consume confirmed custody',()=>storeFixture(async path=>{
 await init(path);const w=new NativeMirrorStore(path);assert.deepEqual(await w.execute({kind:'ProjectSnapshot',args:['/work/p']}),[]);
 const a=ownContainerReceipt(await w.execute({kind:'BeginProject',args:['/work/p',1n,2n,[]]}) as MirrorContainerReceipt);await w.execute({kind:'ConfirmContainer',args:[a,5n]});assert.deepEqual(await w.execute({kind:'UpsertProject',args:['/work/p','P',5n,1]}),[]);assert.deepEqual(records(path),[]);assert.deepEqual(await w.execute({kind:'ProjectSnapshot',args:['/work/./p']}),[['/work/p',5n]]);
}));
test('native cleanup begin and completion retain exact tombstone and no unfinished channels',()=>storeFixture(async path=>{
 await init(path);const w=new NativeMirrorStore(path);const token=await w.execute({kind:'BeginCleanup',args:[3n,null,1]});assert.equal(typeof token,'string');assert.deepEqual(await w.execute({kind:'UnconfirmedCleanup',args:[]}),[3n]);await w.execute({kind:'CompleteCleanup',args:[3n,token as string]});assert.equal(await w.execute({kind:'CleanupPhase',args:[3n]}),'deleted');assert.deepEqual(await w.execute({kind:'UnconfirmedCleanup',args:[]}),[]);
}));
test('only actual rolled-back begin protection is converted to pre-effect mirror refusal',()=>storeFixture(async path=>{
 await init(path);const w=new NativeMirrorStore(path);await w.execute({kind:'BeginCategory',args:[1n,null]});await assert.rejects(w.execute({kind:'BeginCleanup',args:[3n,null,1]}),MirrorCleanupProtectedError);assert.equal(await w.execute({kind:'CleanupPhase',args:[3n]}),null);
 await assert.rejects(w.execute({kind:'BeginCategory',args:[1n,null]}),NativeMirrorStoreUnknownError);assert.equal(records(path).length,1);
}));
test('passive exact request validation refuses malformed operations without native admission',()=>storeFixture(async path=>{
 const w=new NativeMirrorStore(path);let hooks=0;const hostile=new Proxy({kind:'UnconfirmedCleanup',args:[]},{get(){hooks++;throw Error('hook');}});
 for(const q of [hostile,{}, {kind:'UnconfirmedCleanup',args:[],extra:1},{kind:'CategoryReceipt',args:[]},{kind:'CategoryReceipt',args:[1]},{kind:'ProjectSnapshot',args:['\ud800']},{kind:'BeginCleanup',args:[1n,null,Infinity]}])await assert.rejects(w.execute(q as MirrorStoreRequest));assert.equal(hooks,0);assert.equal(ownedWorkerUsage().Control,0);assert.equal(existsSync(path),false);
 const c=new AbortController(),error=new Error('before admission');c.abort(error);await assert.rejects(w.execute({kind:'UnconfirmedCleanup',args:[]},c.signal),e=>e===error);
}));
test('missing request fields cannot invoke Object prototype getters',()=>{
 let hooks=0;const saved=Object.getOwnPropertyDescriptor(Object.prototype,'kind');const d=Object.create(null);d.configurable=true;d.get=()=>{hooks++;return 'UnconfirmedCleanup';};let caught:unknown;
 try{Object.defineProperty(Object.prototype,'kind',d);try{captureMirrorStoreRequest({args:[]} as unknown as MirrorStoreRequest);}catch(e){caught=e;}}finally{if(saved)Object.defineProperty(Object.prototype,'kind',saved);else Reflect.deleteProperty(Object.prototype,'kind');}
 assert.ok(caught instanceof Error);assert.equal(hooks,0);
});
test('lost acknowledgement after native commit retains creation and never replays',async t=>storeFixture(async path=>{
 await init(path);const original=OwnedWorkerSlot.prototype.run;let calls=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<OwnedWorkerSlot['run']>){calls++;return original.apply(this,args).then(()=>{throw Error('lost acknowledgement');});});
 await assert.rejects(new NativeMirrorStore(path).execute({kind:'BeginCategory',args:[1n,null]}),NativeMirrorStoreUnknownError);assert.equal(calls,1);assert.equal(records(path)[0]?.phase,'attempted');assert.equal(ownedWorkerUsage().Control,0);
}));
test('foreign reply cannot grant a result after a successful write',async t=>storeFixture(async path=>{
 await init(path);const original=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<OwnedWorkerSlot['run']>){return original.apply(this,args).then((reply:any)=>({...reply,path:path+'.foreign'}));});
 await assert.rejects(new NativeMirrorStore(path).execute({kind:'BeginCategory',args:[1n,null]}),NativeMirrorStoreUnknownError);assert.equal(records(path).length,1);assert.equal(ownedWorkerUsage().Control,0);
}));
test('same owner rejects overlap and copied arguments resist mutation',()=>storeFixture(async path=>{
 await init(path);const w=new NativeMirrorStore(path),args:[bigint,null]=[1n,null];const pending=w.execute({kind:'BeginCategory',args});args[0]=9n;await assert.rejects(w.execute({kind:'BeginCategory',args:[2n,null]}),OwnedWorkerBusyError);await pending;assert.equal(records(path)[0]?.scope_key,'1');
}));
test('admitted cancellation joins native exit without implying rollback',()=>storeFixture(async path=>{
 await init(path);const w=new NativeMirrorStore(path),c=new AbortController();const promise=w.execute({kind:'BeginCategory',args:[1n,null]},c.signal);const rejected=assert.rejects(promise,NativeMirrorStoreUnknownError);assert.equal(ownedWorkerUsage().Control,1);c.abort(Error('stop'));await rejected;assert.equal(ownedWorkerUsage().Control,0);assert.ok(records(path).length<=1);
}));
