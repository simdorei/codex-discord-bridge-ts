import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeProjectOperationOffThread as decode} from '../../src/remote-agent/native-decode.ts';
import {parseProjectOperation,projectRequestLifetimeSeconds} from '../../src/remote-agent/project-request.ts';
import {RemoteProtocolError} from '../../src/remote-agent/handshake.ts';
import {ownedWorkerUsage,OwnedWorkerSlot,OwnedWorkerBudgetError,OwnedWorkerBusyError,OwnedWorkerTimeoutError} from '../../src/runtime/owned-worker-slot.ts';
const budget=12000000;
test('native decoding returns exact lossless owned immutable operations from all three families',async()=>{
 for(const raw of ['{"kind":"computer_activate","window_id":18446744073709551615}','{"kind":"terminal_exec","command":"echo 안녕","environment":{"__proto__":"safe"}}','{"kind":"file_apply_patch","changes":[{"action":"move","path":"a","destination":"b","expected_sha256":"'+'a'.repeat(64)+'","content":""}]}']){
  const expected=parseProjectOperation(raw,budget),result=await decode(raw,budget);
  // structured clone resets null prototypes; compare values and exact numeric representations.
  assert.deepEqual(result.operation,structuredClone(expected));assert.equal(result.lifetimeSeconds,projectRequestLifetimeSeconds(expected));assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.operation));
  if(result.operation.kind==='terminal_exec'){assert.ok(Object.isFrozen(result.operation.environment));assert.equal(Object.getOwnPropertyDescriptor(result.operation.environment,'__proto__')?.value,'safe');}
  if(result.operation.kind==='file_apply_patch')assert.ok(Object.isFrozen(result.operation.changes)&&Object.isFrozen(result.operation.changes[0]));
  assert.equal(ownedWorkerUsage().Background,0);
 }
});
test('native error retains protocol category and message without pretending a successful result',async()=>{
 for(const raw of ['{"kind":"computer_click"}','{"kind":"terminal_exec","command":""}','{"kind":"unknown"}','{']){
  let expected:unknown;try{parseProjectOperation(raw,budget);}catch(e){expected=e;}
  assert.ok(expected instanceof RemoteProtocolError);
  await assert.rejects(decode(raw,budget),(e:unknown)=>e instanceof RemoteProtocolError&&e.kind===expected.kind&&e.message===expected.message);
  assert.equal(ownedWorkerUsage().Background,0);
 }
});
test('preabort and byte/timeout validation reject before starting a native worker',async()=>{
 const c=new AbortController(),reason=new Error('cancel before decode');c.abort(reason);
 await assert.rejects(decode('{',budget,c.signal),e=>e===reason);assert.equal(ownedWorkerUsage().Background,0);
 const raw='{"kind":"retrieve_image","path":"😀"}';await assert.rejects(decode(raw,Buffer.byteLength(raw)-1),RangeError);
 for(const max of [0,12000001,NaN])await assert.rejects(decode(raw,max),RangeError);
 for(const timeout of [0,10001,NaN])await assert.rejects(decode(raw,budget,undefined,timeout),RangeError);
 assert.equal(ownedWorkerUsage().Background,0);
});
test('local overload and abort/timeout retain capacity until actual native join',async()=>{
 const raw='{"kind":"terminal_window_list"}',first=decode(raw,budget);assert.equal(ownedWorkerUsage().Background,1);
 await assert.rejects(decode(raw,budget),OwnedWorkerBusyError);await first;assert.equal(ownedWorkerUsage().Background,0);
 await assert.rejects(decode(raw,budget,undefined,1),OwnedWorkerTimeoutError);assert.equal(ownedWorkerUsage().Background,0);
 const c=new AbortController(),reason=new Error('cancel accepted decode'),pending=decode(raw,budget,c.signal);c.abort(reason);
 await assert.rejects(pending,e=>e===reason);assert.equal(ownedWorkerUsage().Background,0);
 assert.equal((await decode(raw,budget)).operation.kind,'terminal_window_list');
});
test('large bounded frame is parsed natively while main-thread timers progress',async()=>{
 const raw='{"kind":"save_image","path":"image","data_base64":"'+'x'.repeat(6000000)+'"}';let ticks=0;
 const timer=setInterval(()=>ticks++,2);try{
  const result=await decode(raw,Buffer.byteLength(raw));assert.equal(result.operation.kind,'save_image');
  if(result.operation.kind==='save_image')assert.equal(result.operation.data_base64.length,6000000);
  assert.ok(ticks>1,'main thread should continue scheduling during native parse');
 }finally{clearInterval(timer);}
 assert.equal(ownedWorkerUsage().Background,0);
});

test('native decoder shares finite global background capacity without consuming control capacity',async()=>{
 const url=new URL('data:text/javascript,'+encodeURIComponent("import {parentPort,workerData} from 'node:worker_threads';const a=new Int32Array(workerData);Atomics.wait(a,0,0,5000);parentPort.postMessage(true);parentPort.close();"));
 const shared=new SharedArrayBuffer(4),a=new Int32Array(shared),owners=Array.from({length:3},()=>new OwnedWorkerSlot());
 const pending=owners.map(owner=>owner.run(url,shared,6000));
 try{
  assert.deepEqual(ownedWorkerUsage(),{Background:3,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0});
  await assert.rejects(decode('{"kind":"computer_stop"}',budget),OwnedWorkerBudgetError);
  assert.deepEqual(ownedWorkerUsage(),{Background:3,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0});
 }finally{Atomics.store(a,0,1);Atomics.notify(a,0);await Promise.all(pending);await Promise.all(owners.map(o=>o.join()));}
 assert.deepEqual(ownedWorkerUsage(),{Background:0,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0});
 assert.equal((await decode('{"kind":"computer_stop"}',budget)).operation.kind,'computer_stop');
});
