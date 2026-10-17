import {it} from 'node:test';import assert from 'node:assert/strict';import {setImmediate as tick} from 'node:timers/promises';
import {serveRemoteConnection,RemoteBridgeLifecycleError} from '../../src/remote-agent/connection-lifecycle.ts';
import type {RemoteConnectionPorts} from '../../src/remote-agent/connection-lifecycle.ts';
import {RemoteAgentStatus} from '../../src/remote-agent/agent-state.ts';
import {RemoteFrameError} from '../../src/remote-agent/frame-reader.ts';
import {parseBridgeInboundMessage} from '../../src/remote-agent/bridge-inbound.ts';
import type {BridgeResult} from '../../src/remote-agent/bridge-inbound.ts';
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
const result=(id:string):BridgeResult=>Object.freeze({type:'project_info_result',request_id:id,output:Object.freeze({root:'/fixture',thread_id:'thread'})});
function base():RemoteConnectionPorts{return {beginConnection:async()=>{},retireSessions:async()=>{},receive:async()=>null,send:async()=>{},execute:async c=>result(c.request_id)};}
it('hello acknowledgement precedes connected status and native command/result processing; retirement precedes disconnection',async()=>{
 const status=new RemoteAgentStatus(),stop=new AbortController(),events:string[]=[];let n=0,sent=false;
 const ports:RemoteConnectionPorts={beginConnection:async g=>{assert.equal(g,7n);events.push('begin');},send:async wire=>{const v=parseBridgeInboundMessage(wire,12000000);events.push(v.type);assert.equal(status.isConnected(),v.type!=='hello');if(v.type==='project_info_result')sent=true;},receive:async(hello,signal)=>{assert.equal(hello,n===0);if(n++===0)return '{"type":"hello_ack"}';if(n===2)return '{"type":"project_info","request_id":"r","thread_id":"thread"}';while(!sent){signal.throwIfAborted();await tick();}return null;},execute:async(c,g)=>{assert.equal(g,7n);assert.equal(status.isConnected(),true);events.push('execute');return result(c.request_id);},retireSessions:async()=>{assert.equal(status.isConnected(),true);events.push('retire');}};
 await serveRemoteConnection('device',7n,status,ports,stop.signal);assert.deepEqual(events,['begin','hello','execute','project_info_result','retire']);assert.deepEqual(status.snapshot(),{connected:false,generation:7n});
});
it('missing acknowledgement and EOF both retire once without executing',async()=>{
 for(const raw of [null,'{"type":"project_ack","project_scope":"","binding_id":"1234567890123456"}']){const status=new RemoteAgentStatus();let retired=0,executed=0;
 await assert.rejects(serveRemoteConnection('device',1n,status,{...base(),receive:async()=>raw,execute:async()=>{executed++;return result('x');},retireSessions:async()=>{retired++;}},new AbortController().signal),e=>raw===null?e instanceof RemoteFrameError&&e.kind==='ClosedBeforeHello':e instanceof RemoteBridgeLifecycleError&&e.kind==='MissingHelloAck');assert.equal(retired,1);assert.equal(executed,0);assert.equal(status.isConnected(),false);}
});
it('begin failure preserves raw cause without coercion and still retires',async()=>{
 let hooks=0,retired=0;const cause={toString(){hooks++;return 'bad';}},status=new RemoteAgentStatus();
 await assert.rejects(serveRemoteConnection('device',1n,status,{...base(),beginConnection:async()=>{throw cause;},retireSessions:async()=>{retired++;}},new AbortController().signal),e=>e instanceof RemoteBridgeLifecycleError&&e.phase==='begin'&&e.cause===cause);assert.equal(hooks,0);assert.equal(retired,1);
});
it('retirement failure overrides primary error while retaining it and disconnecting',async()=>{
 const status=new RemoteAgentStatus(),primary=new Error('send'),retirement=new Error('retire');status.setConnected(4n);
 await assert.rejects(serveRemoteConnection('device',5n,status,{...base(),send:async()=>{throw primary;},retireSessions:async()=>{throw retirement;}},new AbortController().signal),e=>e instanceof RemoteBridgeLifecycleError&&e.phase==='retire'&&e.cause===retirement&&e.previous===primary);assert.equal(status.isConnected(),false);
});
it('explicit cancellable-handshake profile joins I/O before retirement and pre-aborted entry has no port effects',async()=>{
 const status=new RemoteAgentStatus(),stop=new AbortController(),entered=deferred<void>(),settle=deferred<void>();let retired=false,done=false;
 const run=serveRemoteConnection('device',1n,status,{...base(),receive:async(_h,s)=>{entered.resolve();await settle.promise;s.throwIfAborted();return null;},retireSessions:async()=>{retired=true;}},stop.signal).then(()=>{done=true;});await entered.promise;stop.abort(new Error('stop'));await tick();assert.equal(retired,false);assert.equal(done,false);settle.resolve();await run;assert.equal(retired,true);
 let calls=0;await serveRemoteConnection('device',2n,status,{beginConnection:async()=>{calls++;},retireSessions:async()=>{calls++;},receive:async()=>{calls++;return null;},send:async()=>{calls++;},execute:async()=>{calls++;return result('x');}},stop.signal);assert.equal(calls,0);
});
it('accepted execution drains before retirement even after shutdown',async()=>{
 const status=new RemoteAgentStatus(),stop=new AbortController(),started=deferred<void>(),cancelled=deferred<void>(),gate=deferred<BridgeResult>();let reads=0,retired=false;
 const run=serveRemoteConnection('device',8n,status,{...base(),receive:async(_hello,signal)=>{if(reads++===0)return '{"type":"hello_ack"}';if(reads===2)return '{"type":"project_info","request_id":"held","thread_id":"thread"}';return new Promise((_,reject)=>{if(signal.aborted){reject(signal.reason);return;}signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});},execute:async(_c,g,s)=>{assert.equal(g,8n);s.addEventListener('abort',()=>cancelled.resolve(),{once:true});started.resolve();return gate.promise;},retireSessions:async()=>{retired=true;}},stop.signal);
 await started.promise;stop.abort();await cancelled.promise;await tick();assert.equal(retired,false);assert.equal(status.isConnected(),true);gate.resolve(result('held'));await run;assert.equal(retired,true);assert.equal(status.isConnected(),false);
});
it('active port getters and forged status fail before I/O with no getter execution',async()=>{
 let hooks=0;const p={...base(),get beginConnection(){hooks++;return async()=>{};}};
 await assert.rejects(serveRemoteConnection('device',1n,new RemoteAgentStatus(),p,new AbortController().signal),TypeError);assert.equal(hooks,0);
 await assert.rejects(serveRemoteConnection('device',1n,Object.create(RemoteAgentStatus.prototype) as RemoteAgentStatus,base(),new AbortController().signal),TypeError);
});
