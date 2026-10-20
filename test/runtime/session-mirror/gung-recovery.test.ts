import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,writeFile} from 'node:fs/promises';
import {join,dirname,toNamespacedPath} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {MirrorTargetBootstrapCoordinator} from '../../../src/runtime/session-mirror/bootstrap-coordinator.ts';
import {NativeMirrorStartupIntentStore} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {captureMirrorStartupCutoff,readMirrorStartupContext} from '../../../src/runtime/session-mirror/startup-context-reader.ts';
import {createVerifiedLocalSessionMirrorProfile} from '../../../src/runtime/discord-runtime/local-session-mirror-profile.ts';
import {readStableMirrorItems} from '../../../src/runtime/session-mirror/read-window.ts';
import {pollBoundMirrorTarget} from '../../../src/runtime/session-mirror/bound-poll.ts';
import {discoverMirrorStore} from '../../../src/runtime/session-mirror/store-discovery.ts';
import {OwnedWorkerSlot} from '../../../src/runtime/owned-worker-slot.ts';
import {sameMirrorRolloutPath} from '../../../src/runtime/session-mirror/rollout-path-binding.ts';

const line=(turn:string)=>JSON.stringify({type:'turn_context',payload:{turn_id:turn}})+'\n';
const message=(text:string)=>JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:text}})+'\n';
const context={maxBytes:16*1048576,maxRecords:20000,maxRecordBytes:262144,maxWindowBytes:65536,maxTurnBytes:16384,timeoutMs:10000};
async function fixture(run:(db:string,file:string,store:NativeMirrorStartupIntentStore,cursors:NativeMirrorCursorStore)=>Promise<void>){
 await storeFixture(async db=>{
  const file=join(dirname(db),'rollout.jsonl');await writeFile(file,line('original'));
  const initialized=await openInitialized(db);try{initialized.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1);}finally{initialized.close();}
  const store=new NativeMirrorStartupIntentStore(db,10000),cursors=new NativeMirrorCursorStore(db,10000);
  try{await cursors.initializeSchema();await store.initializeSchema();await run(db,file,store,cursors);}finally{await store.close();await cursors.close();}
 });
}
async function bootstrap(databasePath:string,rolloutPath:string){
 const owner=new MirrorTargetBootstrapCoordinator({databasePath,rolloutPath,thread:'thread',channel:42n,operationId:'new',createdAt:2,fullPrefix:true,context,totalTimeoutMs:10000});
 try{return await owner.run();}finally{await owner.close();}
}

test('Windows namespace spelling preserves pending cutoff and bound cursor, then delivers appended final once',{skip:process.platform!=='win32'},()=>fixture(async(db,file,store,cursors)=>{
 const alias=toNamespacedPath(file);assert.notEqual(alias,file);
 const cutoff=await captureMirrorStartupCutoff(file,10000,undefined,true);
 await store.retain('thread',cutoff,1,'original-operation');await appendFile(file,message('new final'));
 const resumed=await bootstrap(db,alias);assert.equal(resumed.kind,'Resumed');assert.equal(resumed.cursor.anchor.path,file);assert.equal(resumed.cursor.anchor.offset,cutoff.offset);assert.equal(resumed.cursor.operationId,'original-operation');
 const existing=await bootstrap(db,alias);assert.deepEqual(existing.cursor,resumed.cursor);
 const profile=createVerifiedLocalSessionMirrorProfile({stateDb:db,mirrorDb:db}).worker;
 const jobs=(await discoverMirrorStore(db,profile.discovery.store)).jobs;let calls=0;
 const transport={async sendValidated(){calls++;return 9n;}};
 await pollBoundMirrorTarget(db,{id:'thread',rolloutPath:alias},42n,jobs,profile.poll,transport);
 await pollBoundMirrorTarget(db,{id:'thread',rolloutPath:alias},42n,jobs,profile.poll,transport);
 assert.equal(calls,1);assert.equal((await cursors.read('thread'))!.anchor.path,file);
}));

test('Windows aliases still reject ambiguous spellings, different or missing files and cancellation',{skip:process.platform!=='win32'},()=>fixture(async(_db,file)=>{
 assert.equal(await sameMirrorRolloutPath(file,toNamespacedPath(file)),true);
 for(const ordinary of [file+'.',file+' ',join(dirname(file),'NUL'),dirname(file)+'\\..\\rollout.jsonl',file+'-missing'])assert.equal(await sameMirrorRolloutPath(ordinary,'\\\\?\\'+ordinary),false);
 assert.equal(await sameMirrorRolloutPath(file,toNamespacedPath(file+'-different')),false);
 const abort=new AbortController(),reason=new Error('cancelled alias check');abort.abort(reason);
 await assert.rejects(sameMirrorRolloutPath(file,toNamespacedPath(file),abort.signal),e=>e===reason);
}));

test('startup streams large unrelated records and retains exact pre-append turn and offset',()=>fixture(async(db,file,store)=>{
 const large=JSON.stringify({type:'response_item',payload:{type:'message',content:'😀'.repeat(750000)}})+'\n';
 await writeFile(file,line('before')+large+line('last'));
 const cutoff=await captureMirrorStartupCutoff(file,10000,undefined,true);await store.retain('thread',cutoff,1,'original-operation');
 await appendFile(file,line('later'));
 const result=await bootstrap(db,file);
 assert.equal(result.kind,'Resumed');assert.equal(result.cursor.turn,'last');assert.equal(result.cursor.anchor.offset,cutoff.offset);assert.equal(result.cursor.operationId,'original-operation');
}));

test('large ignored records still validate UTF8, while large context candidates retain the parse budget',()=>fixture(async(_db,file)=>{
 const start=Buffer.from('{"type":"response_item","payload":"'+'x'.repeat(300000));
 await writeFile(file,Buffer.concat([start,Buffer.from([0xff]),Buffer.from('"}\n')]));
 await assert.rejects(readMirrorStartupContext(await captureMirrorStartupCutoff(file),context),e=>e instanceof Error&&Object.getOwnPropertyDescriptor(e,'reason')?.value==='InvalidUtf8');
 await writeFile(file,JSON.stringify({type:'turn_context',payload:{turn_id:'too-large',padding:'x'.repeat(300000)}})+'\n');
 await assert.rejects(readMirrorStartupContext(await captureMirrorStartupCutoff(file),context),e=>e instanceof Error&&Object.getOwnPropertyDescriptor(e,'reason')?.value==='RecordBytes');
}));

test('EOF observations need no decoder worker or unrelated decoder join',()=>fixture(async(db,file)=>{
 await writeFile(file,'');const profile=createVerifiedLocalSessionMirrorProfile({stateDb:db,mirrorDb:db}).worker;let decoded=0;
 const original=OwnedWorkerSlot.prototype.run;
 const hook=test.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){
  if(args[0].pathname.endsWith('/decode-worker.ts')||args[0].pathname.endsWith('/decode-worker.js')){decoded++;throw Error('EOF has no decode work');}
  return original.apply(this,args);
 });
 const busy=test.mock.getter(OwnedWorkerSlot.prototype,'busy',()=>true),joined=test.mock.method(OwnedWorkerSlot.prototype,'join',()=>{throw Error('Must not join an unrelated decoder');});
 try{const result=await readStableMirrorItems(file,0n,profile.poll.read,{thread:'thread',detail:'Send',currentTurn:'old'});assert.equal(result.decoded.nextOffset,0n);assert.equal(result.decoded.collection.currentTurn,'old');assert.equal(decoded,0);}finally{hook.mock.restore();busy.mock.restore();joined.mock.restore();}
}));

test('production record budget accepts a 300 KiB response within the existing one MiB window',()=>fixture(async(db,file)=>{
 const content=JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_image',image_url:'x'.repeat(300000)}]}})+'\n'+message('following final');
 await writeFile(file,content);const profile=createVerifiedLocalSessionMirrorProfile({stateDb:db,mirrorDb:db}).worker;
 const result=await readStableMirrorItems(file,0n,profile.poll.read,{thread:'thread',detail:'Send',currentTurn:'turn'});
 assert.equal(result.decoded.nextOffset,BigInt(Buffer.byteLength(content)));assert.equal(result.decoded.collection.items.at(-1)!.text,'following final');
}));
