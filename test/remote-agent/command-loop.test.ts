import {it} from 'node:test';import assert from 'node:assert/strict';import {setImmediate as tick} from 'node:timers/promises';
import {runRemoteCommandLoop,RemoteCommandLoopError} from '../../src/remote-agent/command-loop.ts';
import type {RemoteCommandLoopPorts} from '../../src/remote-agent/command-loop.ts';
import type {BridgeResult} from '../../src/remote-agent/bridge-inbound.ts';
import {parseBridgeInboundMessage} from '../../src/remote-agent/bridge-inbound.ts';
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function input(){
 const queue:Array<{ok:true;raw:string|null}|{ok:false;error:unknown}>=[];let waiter:((value:(typeof queue)[number])=>void)|null=null;
 const push=(value:(typeof queue)[number])=>{if(waiter!==null){const deliver=waiter;waiter=null;deliver(value);}else queue.push(value);};
 const read=(signal:AbortSignal):Promise<string|null>=>{
  signal.throwIfAborted();if(waiter!==null)throw new Error('parallel read');
  const value=queue.shift();if(value!==undefined)return value.ok?Promise.resolve(value.raw):Promise.reject(value.error);
  return new Promise((resolve,reject)=>{
   const abort=()=>{waiter=null;signal.removeEventListener('abort',abort);reject(signal.reason);};
   waiter=value=>{signal.removeEventListener('abort',abort);value.ok?resolve(value.raw):reject(value.error);};signal.addEventListener('abort',abort,{once:true});
  });
 };
 return {read,text:(raw:string|null)=>push({ok:true,raw}),fail:(error:unknown)=>push({ok:false,error})};
}
const command=(id:string)=>JSON.stringify({type:'project_info',request_id:id,thread_id:'thread'});
const result=(id:string):BridgeResult=>Object.freeze({type:'project_info_result',request_id:id,output:Object.freeze({root:'/fixture',thread_id:'thread'})});
const cancelled=(id:string):BridgeResult=>Object.freeze({type:'operation_error',request_id:id,error_code:'request_cancelled',message:'cancelled'});
it('post-hello owner uses real native codecs, ignores project acknowledgements and sends every selected result',async()=>{
 const source=input(),stop=new AbortController(),sent:string[]=[],seen:bigint[]=[];source.text('{"type":"project_ack","project_scope":"","binding_id":"1234567890123456"}');
 for(const id of ['a','b','c'])source.text(command(id));
 await runRemoteCommandLoop(7n,{receive:source.read,send:async wire=>{const value=parseBridgeInboundMessage(wire,12000000);assert.equal(value.type,'project_info_result');if(value.type==='project_info_result')sent.push(value.request_id);if(sent.length===3)source.text(null);},execute:async(cmd,generation)=>{seen.push(generation);return result(cmd.request_id);}},stop.signal);
 assert.deepEqual(sent,['a','b','c']);assert.deepEqual(seen,[7n,7n,7n]);
});
it('EOF requests cancellation and does not return before actual accepted execution settles',async()=>{
 const source=input(),stop=new AbortController(),started=deferred<void>(),observedCancel=deferred<void>(),gate=deferred<BridgeResult>();source.text(command('held'));let sent=0,done=false;
 const running=runRemoteCommandLoop(1n,{receive:source.read,send:async()=>{sent++;},execute:async(_cmd,_generation,signal)=>{signal.addEventListener('abort',()=>observedCancel.resolve(),{once:true});started.resolve();return gate.promise;}},stop.signal).then(()=>{done=true;});
 await started.promise;source.text(null);await observedCancel.promise;await tick();assert.equal(done,false);gate.resolve(result('held'));await running;assert.equal(sent,0);
});
it('ready-but-unselected failed work is retained when EOF wins and original transport failure still takes precedence',async()=>{
 for(const withTransportError of [false,true]){
  const source=input(),stop=new AbortController(),started=deferred<void>(),cancel=deferred<void>(),gate=deferred<BridgeResult>(),job=new Error('job'),transport=new Error('transport');source.text(command('failure'));
  const running=runRemoteCommandLoop(1n,{receive:source.read,send:async()=>{},execute:async(_c,_g,signal)=>{signal.addEventListener('abort',()=>cancel.resolve(),{once:true});started.resolve();return gate.promise;}},stop.signal);
  const checked=assert.rejects(running,e=>withTransportError?e===transport:e instanceof RemoteCommandLoopError&&e.kind==='Worker'&&e.cause===job);
  await started.promise;if(withTransportError)source.fail(transport);else source.text(null);await cancel.promise;gate.reject(job);await checked;
 }
});
it('sixteen pending commands admit only four active; seventeenth receives exact bridge_busy without execution',async()=>{
 const source=input(),stop=new AbortController(),gate=deferred<void>(),busy=deferred<BridgeResult>(),cancel=deferred<void>();let activeStarted=0,totalInvoked=0;
 for(let i=0;i<17;i++)source.text(command(String(i)));
 const running=runRemoteCommandLoop(3n,{receive:source.read,send:async wire=>{const r=parseBridgeInboundMessage(wire,12000000);if(r.type==='operation_error'&&r.error_code==='bridge_busy')busy.resolve(r);},execute:async(cmd,generation,signal)=>{totalInvoked++;assert.equal(generation,3n);if(signal.aborted)return cancelled(cmd.request_id);activeStarted++;signal.addEventListener('abort',()=>cancel.resolve(),{once:true});await gate.promise;return result(cmd.request_id);}},stop.signal);
 const refused=await busy.promise;assert.equal(refused.type,'operation_error');if(refused.type==='operation_error'){assert.equal(refused.request_id,'16');assert.equal(refused.message,'The local bridge is busy. Retry this request shortly.');}
 assert.equal(activeStarted,4);assert.equal(totalInvoked,4);stop.abort();await cancel.promise;gate.resolve();await running;assert.equal(totalInvoked,16);assert.equal(activeStarted,4);
});
it('duplicate hello rejects without executing a command and pre-aborted owner starts no I/O',async()=>{
 const source=input(),stop=new AbortController();let calls=0;source.text('{"type":"hello_ack"}');
 await assert.rejects(runRemoteCommandLoop(1n,{receive:source.read,send:async()=>{},execute:async()=>{calls++;return result('x');}},stop.signal),e=>e instanceof RemoteCommandLoopError&&e.kind==='DuplicateHello');assert.equal(calls,0);
 stop.abort();await runRemoteCommandLoop(1n,{receive:async()=>{calls++;return null;},send:async()=>{calls++;},execute:async()=>{calls++;return result('x');}},stop.signal);assert.equal(calls,0);
});
it('send failure retains its original identity while outstanding receive is joined',async()=>{
 const source=input(),stop=new AbortController(),sentinel=new Error('send');source.text(command('a'));
 await assert.rejects(runRemoteCommandLoop(1n,{receive:source.read,send:async()=>{throw sentinel;},execute:async cmd=>result(cmd.request_id)},stop.signal),e=>e===sentinel);
});
it('active port fields and thenable reads cannot invoke getters or then hooks',async()=>{
 let hooks=0;const stop=new AbortController(),ports={get receive(){hooks++;return async()=>null;},send:async()=>{},execute:async()=>result('x')};
 await assert.rejects(runRemoteCommandLoop(1n,ports,stop.signal),TypeError);assert.equal(hooks,0);
 const receive=(()=>({then(){hooks++;}})) as unknown as RemoteCommandLoopPorts['receive'];await assert.rejects(runRemoteCommandLoop(1n,{receive,send:async()=>{},execute:async()=>result('x')},stop.signal),TypeError);assert.equal(hooks,0);
});
