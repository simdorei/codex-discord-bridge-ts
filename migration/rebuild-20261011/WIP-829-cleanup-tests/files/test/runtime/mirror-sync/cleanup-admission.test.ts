import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {isMirrorChannelMapped} from '../../../src/store/mirror-policy-read.ts';
import {NativeMirrorStore} from '../../../src/runtime/mirror-sync/store-native.ts';
import {MirrorCleanupAdmission} from '../../../src/runtime/mirror-sync/cleanup-admission.ts';
import {captureMirrorStoreResult} from '../../../src/runtime/mirror-sync/store-native-protocol.ts';
import {MirrorCleanupProtectedError} from '../../../src/runtime/cleanup-refusal.ts';
const signal=()=>new AbortController().signal;
test('null membership never creates a database and zero uses the source query',async()=>storeFixture(async path=>{
 assert.equal(await isMirrorChannelMapped(path,null),false); assert.equal(existsSync(path),false);
 const db=await openInitialized(path); try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,1)').run('zero','p','title',0n,3n);}finally{db.close();}
 assert.equal(await isMirrorChannelMapped(path,0n),true);assert.equal(await isMirrorChannelMapped(path,3n),true);assert.equal(await isMirrorChannelMapped(path,99n),false);
}));
test('native cleanup reads preserve exact thread, parent and project mappings',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,1)').run('thread','p','title',2n,3n);db.prepare('INSERT INTO mirror_projects VALUES(?,?,?,1)').run('p','project',4n);}finally{db.close();}
 const store=new NativeMirrorStore(path);
 for(const id of [2n,3n,4n])assert.equal(await store.execute({kind:'IsMapped',args:[id]}),true);
 assert.equal(await store.execute({kind:'IsMapped',args:[5n]}),false);
 assert.deepEqual(await store.execute({kind:'MirrorTargets',args:[]}),[{codexThreadId:'thread',threadTitle:'title',discordChannelId:2n,discordThreadId:3n}]);
 assert.deepEqual(await store.execute({kind:'RemainingIds',args:[]}),{threadIds:[3n],projectChannelIds:[4n]});
}));
test('clear admission does not create a cleanup fence or retire mappings',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,1)').run('thread','p','title',2n,3n);}finally{db.close();}
 const store=new NativeMirrorStore(path);await new MirrorCleanupAdmission(store).ensureNoRequests(3n,signal());
 assert.equal(await store.execute({kind:'CleanupPhase',args:[3n]}),null);assert.equal(await store.execute({kind:'IsMapped',args:[3n]}),true);
}));
test('ingress protects the room and read-only admission never creates a fence',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{db.exec("INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,target_thread_id,state,phase,confirmation_delivered,payload_json,created_at,updated_at) VALUES('i','message',3,1,'thread','staged','received',0,'{}',1,1)");}finally{db.close();}
 const store=new NativeMirrorStore(path);await assert.rejects(new MirrorCleanupAdmission(store).ensureNoRequests(3n,signal()),(e:unknown)=>e instanceof MirrorCleanupProtectedError);
 assert.equal(await store.execute({kind:'CleanupPhase',args:[3n]}),null);
}));
test('strict cleanup result shapes reject precision loss and missing or extra fields',()=>{
 assert.throws(()=>captureMirrorStoreResult('IsMapped',1));
 assert.throws(()=>captureMirrorStoreResult('RemainingIds',{threadIds:[3],projectChannelIds:[]}));
 assert.throws(()=>captureMirrorStoreResult('RemainingIds',{threadIds:[],projectChannelIds:[],extra:true}));
 assert.throws(()=>captureMirrorStoreResult('MirrorTargets',[{codexThreadId:'x',threadTitle:'t',discordThreadId:3n}]));
});
test('pre-abort preserves exact reason before touching a fresh database',async()=>storeFixture(async path=>{
 const abort=new AbortController(),reason=new Error('cancel');abort.abort(reason);
 await assert.rejects(new MirrorCleanupAdmission(new NativeMirrorStore(path)).ensureNoRequests(3n,abort.signal),e=>e===reason);assert.equal(existsSync(path),false);
}));
