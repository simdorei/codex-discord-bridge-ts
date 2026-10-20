import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {NativeMirrorStore,NativeMirrorStoreUnknownError} from '../../../src/runtime/mirror-sync/store-native.ts';
import {captureMirrorStoreRequest,captureMirrorStoreResult,type MirrorStoreRequest} from '../../../src/runtime/mirror-sync/store-native-protocol.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
async function seed(path:string){const db=await openInitialized(path);try{
 db.prepare('INSERT INTO mirror_projects(project_key,project_name,discord_channel_id,updated_at) VALUES(?,?,?,?)').run('/p','P',2n,1);
 db.prepare('INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at) VALUES(?,?,?,?,?,?)').run('t','/p','T',2n,3n,1);
}finally{db.close();}}
test('native stale snapshots preserve fields and valid identity exclusion',()=>storeFixture(async path=>{
 await seed(path);const w=new NativeMirrorStore(path);
 assert.deepEqual(await w.execute({kind:'StaleThreads',args:[[],2]}),[{threadId:'t',discordThreadId:3n,title:'T'}]);
 assert.deepEqual(await w.execute({kind:'StaleThreads',args:[['t'],2]}),[]);
 assert.deepEqual(await w.execute({kind:'StaleProjects',args:[[],2]}),[{projectKey:'/p',projectName:'P',discordChannelId:2n}]);
 assert.deepEqual(await w.execute({kind:'StaleProjects',args:[['/p'],2]}),[]);
 assert.deepEqual(await w.execute({kind:'StaleThreads',args:[[],1]}),[]);
}));
test('native retirement preserves identity, strict cutoff and parent protection',()=>storeFixture(async path=>{
 await seed(path);const w=new NativeMirrorStore(path);
 assert.equal(await w.execute({kind:'RetireProject',args:['/p',2n,2]}),false);
 assert.equal(await w.execute({kind:'RetireThread',args:['t',4n,2]}),false);
 assert.equal(await w.execute({kind:'RetireThread',args:['t',3n,1]}),false);
 assert.equal(await w.execute({kind:'RetireThread',args:['t',3n,2]}),true);
 assert.equal(await w.execute({kind:'RetireThread',args:['t',3n,2]}),false);
 assert.equal(await w.execute({kind:'RetireProject',args:['/p',9n,2]}),false);
 assert.equal(await w.execute({kind:'RetireProject',args:['/p',2n,2]}),true);
 assert.equal(ownedWorkerUsage().Control,0);
}));
test('stale/retirement request and reply are strict passive bounded data',()=>{
 for(const q of [{kind:'StaleThreads',args:[['\ud800'],2]},{kind:'StaleProjects',args:[[],NaN]},{kind:'RetireThread',args:['t',3,2]},{kind:'RetireProject',args:['p',2n,Infinity]}])assert.throws(()=>captureMirrorStoreRequest(q as unknown as MirrorStoreRequest));
 for(const v of [[{threadId:'t',discordThreadId:3,title:'T'}],[{threadId:'t',discordThreadId:3n,title:'T',extra:1}],null])assert.throws(()=>captureMirrorStoreResult('StaleThreads',v));
 let calls=0;const row=Object.create(null);Object.defineProperty(row,'threadId',{get(){calls++;return 't';},enumerable:true});assert.throws(()=>captureMirrorStoreResult('StaleThreads',[row]));assert.equal(calls,0);
 assert.throws(()=>captureMirrorStoreResult('RetireThread',null));
});
test('lost retirement acknowledgement is unknown even when exact deletion committed',async t=>storeFixture(async path=>{
 await seed(path);const original=OwnedWorkerSlot.prototype.run;let calls=0;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<OwnedWorkerSlot['run']>){calls++;return original.apply(this,args).then(()=>{throw Error('lost acknowledgement');});});
 await assert.rejects(new NativeMirrorStore(path).execute({kind:'RetireThread',args:['t',3n,2]}),NativeMirrorStoreUnknownError);
 const db=new DatabaseSync(path);try{assert.equal(db.prepare('SELECT count(*) AS n FROM mirror_threads').get()?.n,0);}finally{db.close();}
 assert.equal(calls,1);assert.equal(ownedWorkerUsage().Control,0);
}));
