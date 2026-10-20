import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';
import {NativeTypingInventoryReader} from '../../src/runtime/completion/native-typing.ts';
import {sendTyping,type TypingBackend,type TypingInventory} from '../../src/runtime/completion/typing.ts';import {TerminalFence} from '../../src/runtime/completion/terminal-fence.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';import {openInitialized} from '../../src/store/owned-driver.ts';
import {ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';import {storeFixture} from '../helpers/store-fixture.ts';import {queueJob} from '../helpers/queue-job.ts';
const backend=():TypingBackend=>({generation:()=>1n,lifecycleSnapshot:async()=>({healthy:true,quarantined:false,restartPending:false}),activeTurnId:async()=> 'turn',subscribeLifecycle:()=>({hasChanged:()=>false,changed:signal=>new Promise((_resolve,reject)=>{signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});}),dispose(){}})});
const store={listFiltered:async()=>{throw Error('main SQL forbidden');},pendingObservedCompletions:async()=>{throw Error('main SQL forbidden');}};
const inventory:TypingInventory={jobs:[{targetThreadId:'target',turnId:'turn',state:'Running',goalWaiting:false,channelId:9007199254740993n}],terminals:[]};
test('native typing returns exact minimal all-row projection after both full strict decoders',async()=>storeFixture(async path=>{
 await state.enqueue(path,queueJob({jobId:'run',targetThreadId:'target',channelId:9007199254740993n,state:'Running',turnId:'turn'}));await state.enqueue(path,queueJob({jobId:'pending',targetThreadId:'other'}));const db=await openInitialized(path);db.exec("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES ('target','turn',1,'{}')");db.close();
 const a=new NativeTypingInventoryReader(path);try{const expectedJobs=(await state.listFiltered(path,null,null)).map(j=>({targetThreadId:j.targetThreadId,turnId:j.turnId,state:j.state,goalWaiting:j.goalWaiting,channelId:j.channelId}));assert.deepEqual(await a.read(),{jobs:expectedJobs,terminals:[{threadId:'target',turnId:'turn'}]});let sent=0;await sendTyping(path,backend(),new TerminalFence(),{async createTyping(){sent++;}},store,undefined,a);assert.equal(sent,0);assert.equal(ownedWorkerUsage().Background,0);}finally{await a.close();}
}));
test('malformed irrelevant queue row rejects whole native typing pass rather than filtering first',async()=>storeFixture(async path=>{
 await state.enqueue(path,queueJob({jobId:'irrelevant',state:'Pending'}));const db=await openInitialized(path);db.exec("UPDATE codex_turn_queue SET baseline_turn_ids='not json'");db.close();const a=new NativeTypingInventoryReader(path);try{await assert.rejects(a.read(),/unavailable/);}finally{await a.close();}
}));
test('terminal payload is still strictly decoded before dropping payload from projected result',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.exec("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES ('irrelevant','turn',1,CAST(x'ff' AS TEXT))");db.close();const a=new NativeTypingInventoryReader(path);try{await assert.rejects(a.read(),/unavailable/);}finally{await a.close();}
}));
test('missing store, preabort and closed owner cannot initialize or return empty permission',async()=>storeFixture(async path=>{
 const a=new NativeTypingInventoryReader(path),c=new AbortController(),reason=Error('cancel');c.abort(reason);assert.throws(()=>a.read(c.signal),e=>e===reason);assert.equal(ownedWorkerUsage().Background,0);await assert.rejects(a.read());assert.equal(existsSync(path),false);await a.close();assert.throws(()=>a.read(),/unavailable/);
}));
test('native lookup retains newly observed terminal stop and rechecks lifecycle before HTTP',async()=>{
 const f=new TerminalFence(),b=backend();let sent=0;await sendTyping('unused',b,f,{async createTyping(){sent++;}},store,undefined,{async read(){f.stop(1n,'target','turn');return inventory;}});assert.equal(sent,0);assert.equal(f.stopped(1n,'target','turn'),true);
 let changed=false;b.subscribeLifecycle=()=>({hasChanged:()=>changed,changed:async()=>{},dispose(){}});await sendTyping('unused',b,new TerminalFence(),{async createTyping(){sent++;}},store,undefined,{async read(){changed=true;return inventory;}});assert.equal(sent,0);
});
test('cancellation during owned native lookup admits no HTTP and preserves fence before retention',async()=>{
 const c=new AbortController(),reason=Error('stop'),f=new TerminalFence();f.stop(1n,'other','turn');let sent=0;await assert.rejects(sendTyping('unused',backend(),f,{async createTyping(){sent++;}},store,c.signal,{async read(){c.abort(reason);return inventory;}}),e=>e===reason);assert.equal(sent,0);assert.equal(f.stopped(1n,'other','turn'),true);
});
test('native projected inventory retains precise channel and original HTTP revocation join',async()=>{
 const f=new TerminalFence();let began!:()=>void,finish!:()=>void,aborted=false,returned=false;const entered=new Promise<void>(r=>began=r),channels:bigint[]=[];
 const task=sendTyping('unused',backend(),f,{async createTyping(channel,signal){channels.push(channel);began();await new Promise<void>(r=>{finish=r;signal.addEventListener('abort',()=>{aborted=true;},{once:true});});}},store,undefined,{async read(){return inventory;}}).then(()=>{returned=true;});await entered;f.stop(1n,'target','turn');for(let i=0;i<12;i++)await Promise.resolve();try{assert.equal(aborted,true);assert.equal(returned,false);assert.deepEqual(channels,[9007199254740993n]);}finally{finish();await task;}assert.equal(f.pendingSubscribers,0);
});
