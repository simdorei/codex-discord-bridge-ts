import assert from 'node:assert/strict';
import test from 'node:test';
import {storeFixture} from '../helpers/store-fixture.ts';
import {instrumentStoreWorker,releaseTrace,waitTrace} from '../helpers/store-authority-worker-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {NativeBridgeStateOwner} from '../../src/runtime/bridge-state-native.ts';
import {createNativeMessageClassifier} from '../../src/runtime/message-worker/classification.ts';
import {decodeGatewayMessage} from '../../src/discord/gateway/decoded-message.ts';
import {InteractionAccessPolicy} from '../../src/discord/interaction-access.ts';
import {OwnedWorkerSlot,withOwnedWorkerReuse,withOwnedWorkerBackpressure,closeOwnedWorkerPool,ownedWorkerReuseStats} from '../../src/runtime/owned-worker-slot.ts';

const extension=import.meta.url.endsWith('.js')?'.js':'.ts';
const pooled=(run:()=>Promise<void>)=>withOwnedWorkerReuse(()=>withOwnedWorkerBackpressure(async()=>{try{await run();}finally{await closeOwnedWorkerPool();}}));
const stopUrl=new URL('../../src/runtime/action-executor/stop-pending-native-worker.ts',import.meta.url);

test('Bridge file operations progress while the database control worker is occupied',()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const trace=new SharedArrayBuffer(8);
 const restore=instrumentStoreWorker({match:'reusable-store-worker'+extension,trace,before:'Atomics.store(trace,0,1);Atomics.wait(trace,1,0,15000);',after:''});
 try{await pooled(async()=>{
  const slot=new OwnedWorkerSlot('Control');
  const blocked=slot.run(stopUrl,{id:'held',path,operation:'Pending',after:0n},10000);
  try{
   await waitTrace(trace);
   const bridge=new NativeBridgeStateOwner(path+'.bridge.json');
   await bridge.execute({kind:'Select',id:'T'},undefined,1500);
   assert.equal(await bridge.execute({kind:'Selected'},undefined,1500),'T');
   assert.equal(Atomics.load(new Int32Array(trace),1),0,'database worker must still be blocked');
  }finally{releaseTrace(trace);await blocked;await slot.join();}
 });}finally{restore();}
}));

test('alternating journal, intake, and Bridge operations retain warm workers and fresh inputs',()=>storeFixture(async path=>{
 (await openInitialized(path)).close();
 await pooled(async()=>{
  const slot=new OwnedWorkerSlot('Control'),bridge=new NativeBridgeStateOwner(path+'.bridge.json');
  const journal=new URL('../../src/runtime/message-worker/native-journal-worker.ts',import.meta.url);
  const intake=new URL('../../src/runtime/prompt-intake/native-state-worker.ts',import.meta.url);
  const classify=createNativeMessageClassifier(path,{maxRows:100n,maxValueBytes:65536n,maxOutputBytes:65536,timeoutMs:5000});
  const policy=new InteractionAccessPolicy({allowAllChannels:true,allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[]});
  for(let i=0;i<4;i++){
   const id='request-'+i;
   const message=decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'7',content:'hello',edited_timestamp:null,embeds:[],id:String(i+1),mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2026-10-19T00:00:00+00:00',tts:false,type:0}));
   assert.equal((await classify(message,path,{enableMessageContent:true,plainAskMentionUserIds:new Set()},policy,null)).kind,'Candidate');
   const admitted:any=await slot.run(journal,{path,id,operation:'Admit',envelope:{ingressId:id,kind:'message',eventId:BigInt(i+1),applicationId:null,channelId:7n,ownerUserId:2n,sourceMessageId:BigInt(i+1),payloadJson:'{}',targetThreadId:null,canonicalOwner:null,now:1}},5000);
   assert.equal(admitted.ok,true);assert.equal(admitted.value.created,true);
   const read:any=await slot.run(intake,{path,operation:'IngressRead',id},5000);
   assert.equal(read.ok,true);assert.equal(read.value.id,id);assert.equal(read.value.record.ingressId,id);
   await bridge.execute({kind:'Select',id});
   assert.equal(await bridge.execute({kind:'Selected'}),id);
  }
  assert.deepEqual(ownedWorkerReuseStats(),{started:3,reused:17,live:3});
 });
}));

test('a forty-second idle interval retains runtime workers until explicit pool shutdown',t=>storeFixture(async path=>{
 (await openInitialized(path)).close();
 await pooled(async()=>{
  t.mock.timers.enable({apis:['setTimeout']});
  try{
   const slot=new OwnedWorkerSlot('Control');
   assert.deepEqual(await slot.run(stopUrl,{id:'before-idle',path,operation:'Pending',after:0n},5000),{id:'before-idle',path,operation:'Pending',after:0n,ok:true,rows:[]});
   t.mock.timers.tick(40000);
   const reply:any=await slot.run(stopUrl,{id:'after-idle',path,operation:'Pending',after:0n},5000);
   assert.equal(reply.id,'after-idle');assert.deepEqual(reply.rows,[]);
   assert.deepEqual(ownedWorkerReuseStats(),{started:1,reused:1,live:1});
  }finally{t.mock.timers.reset();}
 });
}));
