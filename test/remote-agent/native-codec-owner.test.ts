import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {RemoteNativeCodecOwner,requireRemoteNativeCodecOwner,serializeBridgeMessageOffThread} from '../../src/remote-agent/native-decode.ts';
import {RemoteMutationCache} from '../../src/remote-agent/mutation-cache.ts';
import {RemoteProjectDispatcher} from '../../src/remote-agent/project-dispatcher.ts';
import {runRemoteCommandLoop} from '../../src/remote-agent/command-loop.ts';
import {parseGatewayCommand} from '../../src/remote-agent/gateway-command.ts';
import {parseBridgeInboundMessage,type BridgeResult} from '../../src/remote-agent/bridge-inbound.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,OwnedWorkerBudgetError,OwnedWorkerTimeoutError,OWNED_WORKER_LIMITS,ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';

const bytes=1048576,sid='abcdefghijklmnop';
const command=(requestId='synthetic-owner',type='write_file',extra:object={})=>parseGatewayCommand(JSON.stringify({type,request_id:requestId,thread_id:'synthetic-thread',computer_session_id:sid,deadline_at:'1970-01-01T00:03:20Z',...(type==='write_file'?{path:'a',content:'value'}:{}),...(type==='project_session'?{computer_session_generation:1}:{}),...extra}),bytes,0);
const result=(requestId='synthetic-owner'):BridgeResult=>Object.freeze({type:'write_file_result',request_id:requestId,output:Object.freeze({path:'a',sha256:'a'.repeat(64),bytes_written:5n,created:true})});
const refusal:BridgeResult=Object.freeze({type:'operation_error',request_id:'synthetic-overflow',error_code:'bridge_busy',message:'The local bridge is busy. Retry this request shortly.'});
const wireCommand=JSON.stringify({type:'project_info',request_id:'synthetic-parse',thread_id:'synthetic-thread'});
const same=(a:unknown,b:unknown)=>assert.deepEqual(structuredClone(a),structuredClone(b));

test('distinct wire/cache owners deterministically overlap parse, refusal and result with remember and retained lookup',{timeout:15000},async()=>{
 const wire=new RemoteNativeCodecOwner(),cacheCodec=new RemoteNativeCodecOwner(),cache=new RemoteMutationCache(4194304,256,bytes,cacheCodec),c=command(),r=result();
 const wireWork=[()=>wire.decodeGatewayMessageOffThread(wireCommand,bytes),()=>wire.serializeBridgeMessageOffThread(refusal,bytes),()=>wire.serializeBridgeMessageOffThread(r,bytes)];
 for(const retained of [false,true])for(const work of wireWork){
  const cached=retained?cache.lookup(c):cache.remember(c,r),encoded=work();
  assert.equal(cacheCodec.busy,true);assert.equal(wire.busy,true);assert.equal(ownedWorkerUsage().Background,2);
  await assert.rejects(wire.decodeGatewayMessageOffThread('{"type":"hello_ack"}',bytes),e=>e instanceof OwnedWorkerBusyError&&!(e instanceof OwnedWorkerBudgetError));
  await assert.rejects(cacheCodec.fingerprintGatewayCommandOffThread(c,bytes),e=>e instanceof OwnedWorkerBusyError&&!(e instanceof OwnedWorkerBudgetError));
  const [stored,output]=await Promise.all([cached,encoded]);if(retained)same(stored,r);else assert.equal(stored,'Retained');
  if(typeof output==='string'){const parsed=parseBridgeInboundMessage(output,bytes);assert.equal(parsed.type==='operation_error'?parsed.request_id:'request_id'in parsed?parsed.request_id:null,parsed.type==='operation_error'?'synthetic-overflow':'synthetic-owner');}
  else assert.equal(output.type,'project_info');
  assert.equal(ownedWorkerUsage().Background,0);
 }
 await Promise.all([wire.join(),cacheCodec.join()]);assert.equal(cache.size,1);
});

test('independent owner fingerprint and serialization overlap while compatibility helper reentry still refuses',async()=>{
 const wire=new RemoteNativeCodecOwner(),cache=new RemoteNativeCodecOwner();
 for(const cacheWork of [()=>cache.fingerprintGatewayCommandOffThread(command(),bytes),()=>cache.serializeBridgeMessageOffThread(result(),bytes)]){
  const retained=cacheWork(),sent=wire.serializeBridgeMessageOffThread(result(),bytes);assert.equal(ownedWorkerUsage().Background,2);await Promise.all([retained,sent]);
 }
 const first=serializeBridgeMessageOffThread(result(),bytes);await assert.rejects(serializeBridgeMessageOffThread(refusal,bytes),OwnedWorkerBusyError);await first;assert.equal(ownedWorkerUsage().Background,0);
});

test('compatibility cache reproduces the original direct wire collision without dropping its native owner',async()=>{
 const cache=new RemoteMutationCache(),pending=cache.remember(command(),result());
 assert.equal(cache.busy,true);assert.equal(ownedWorkerUsage().Background,1);
 await assert.rejects(serializeBridgeMessageOffThread(result(),bytes),e=>e instanceof OwnedWorkerBusyError&&!(e instanceof OwnedWorkerBudgetError));
 assert.equal(await pending,'Retained');assert.equal(cache.busy,false);assert.equal(ownedWorkerUsage().Background,0);same(await cache.lookup(command()),result());
});

test('real dispatcher remember, read validation and reconnect cache lookup overlap wire output without backend replay',{timeout:15000},async()=>{
 const date=(seconds:bigint)=>Object.freeze({seconds,nanosecond:0n});let writes=0;
 const dispatcher=new RemoteProjectDispatcher({nowUtc:()=>date(100n),nowMonotonic:()=>0n,openProject:async()=>({close:async()=>{},createSession:async()=>({stopComputer:async()=>{},closeTerminalWindows:async()=>{},closeTerminals:async()=>{},computer:null,terminal:null,terminalWindow:null}),listFiles:null,readFile:null,core:null,writeFile:async()=>{writes++;return (result() as Extract<BridgeResult,{type:'write_file_result'}>).output;}})});
 const wire=new RemoteNativeCodecOwner(),stop=new AbortController();
 const overlap=async<T>(pending:Promise<T>)=>{
  const began=performance.now();while(ownedWorkerUsage().Background===0){if(performance.now()-began>10000)throw Error('Dispatcher did not start its native codec');await tick();}
  assert.equal(ownedWorkerUsage().Background,1);const sent=wire.serializeBridgeMessageOffThread(refusal,bytes);assert.equal(ownedWorkerUsage().Background,2);const [value,text]=await Promise.all([pending,sent]);assert.equal(parseBridgeInboundMessage(text,bytes).type,'operation_error');assert.equal(ownedWorkerUsage().Background,0);return value;
 };
 try{
  await dispatcher.upsert({threadId:'synthetic-thread',root:'/synthetic/project',expiresAt:date(300n)});let connection=await dispatcher.beginConnection(1n);
  await dispatcher.execute(command('synthetic-session','project_session'),connection,stop.signal);
  const first=await overlap(dispatcher.execute(command(),connection,stop.signal));same(first,result());assert.equal(writes,1);
  const read=await overlap(dispatcher.execute(command('synthetic-read','project_info'),connection,stop.signal));assert.equal(read.type,'project_info_result');
  await dispatcher.retireConnection(connection);connection=await dispatcher.beginConnection(2n);await dispatcher.execute(command('synthetic-session-next','project_session'),connection,stop.signal);
  same(await overlap(dispatcher.execute(command(),connection,stop.signal)),first);assert.equal(writes,1);
 }finally{await dispatcher.close();await wire.join();}
 assert.equal(dispatcher.snapshot().accepted,0);assert.equal(ownedWorkerUsage().Background,0);
});

test('abort and timeout keep each codec receipt pending through actual native exit before join completes',{timeout:15000},async()=>{
 for(const timeout of [false,true]){
  const owner=new RemoteNativeCodecOwner(),stop=new AbortController(),reason=new Error('synthetic codec cancellation');
  const pending=owner.serializeBridgeMessageOffThread(result(),bytes,stop.signal,timeout?1:6000);let settled=false,joined=false;
  const checked=assert.rejects(pending,e=>timeout?e instanceof OwnedWorkerTimeoutError:e===reason).then(()=>{settled=true;assert.equal(owner.busy,false);assert.equal(ownedWorkerUsage().Background,0);});
  const joining=owner.join().then(()=>{joined=true;});if(!timeout)stop.abort(reason);
  assert.equal(owner.busy,true);assert.equal(settled,false);assert.equal(joined,false);
  await assert.rejects(owner.decodeGatewayMessageOffThread('{"type":"hello_ack"}',bytes),OwnedWorkerBusyError);
  await Promise.all([checked,joining]);assert.equal(joined,true);assert.equal((await owner.decodeGatewayMessageOffThread('{"type":"hello_ack"}',bytes)).type,'hello_ack');
 }
});

test('true global Background exhaustion remains a distinct explicit refusal with unchanged finite budgets',{timeout:15000},async()=>{
 assert.deepEqual(OWNED_WORKER_LIMITS,{Background:3,Control:1,Observation:2,Discovery:1,Maintenance:1});
 const shared=new SharedArrayBuffer(4),gate=new Int32Array(shared),held=Array.from({length:3},()=>new OwnedWorkerSlot());
 const module=new URL('data:text/javascript,'+encodeURIComponent("import {parentPort,workerData} from 'node:worker_threads';Atomics.wait(new Int32Array(workerData),0,0,10000);parentPort.postMessage('settled');parentPort.close();"));
 const running=held.map(owner=>owner.run(module,shared,12000));const all=Promise.all(running);
 try{
  assert.equal(ownedWorkerUsage().Background,3);const codec=new RemoteNativeCodecOwner();await assert.rejects(codec.serializeBridgeMessageOffThread(refusal,bytes),OwnedWorkerBudgetError);assert.equal(codec.busy,false);assert.equal(ownedWorkerUsage().Background,3);await codec.join();
 }finally{Atomics.store(gate,0,1);Atomics.notify(gate,0);await all;await Promise.all(held.map(owner=>owner.join()));}
 assert.equal(ownedWorkerUsage().Background,0);
});

test('foreign, copied, proxied and overridden codecs fail before trap or port execution',async()=>{
 const valid=new RemoteNativeCodecOwner();let hooks=0;class Override extends RemoteNativeCodecOwner{override join(){hooks++;return Promise.resolve();}}
 const fake={get serializeBridgeMessageOffThread(){hooks++;throw Error('getter');}},proxy=new Proxy(valid,{get(){hooks++;throw Error('proxy');},getPrototypeOf(){hooks++;throw Error('prototype');}});
 for(const codec of [fake,{...valid},Object.create(RemoteNativeCodecOwner.prototype),proxy,new Override()]){
  assert.throws(()=>requireRemoteNativeCodecOwner(codec),TypeError);assert.throws(()=>new RemoteMutationCache(1000,2,1000,codec as RemoteNativeCodecOwner),TypeError);
  await assert.rejects(runRemoteCommandLoop(1n,{receive:async()=>{hooks++;return null;},send:async()=>{hooks++;},execute:async()=>{hooks++;return result();}},new AbortController().signal,bytes,codec as RemoteNativeCodecOwner),TypeError);
 }
 assert.equal(hooks,0);assert.equal(Object.isFrozen(valid),true);assert.equal(Object.isFrozen(RemoteNativeCodecOwner.prototype),true);requireRemoteNativeCodecOwner(valid);
});
