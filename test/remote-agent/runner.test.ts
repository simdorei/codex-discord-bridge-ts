import {it} from 'node:test';import assert from 'node:assert/strict';import {setImmediate as tick} from 'node:timers/promises';
import {runRemoteAgentLoop,waitRemoteReconnect} from '../../src/remote-agent/runner.ts';import type {RemoteDisconnect} from '../../src/remote-agent/runner.ts';
import {serveRemoteConnection} from '../../src/remote-agent/connection-lifecycle.ts';import {RemoteAgentStatus} from '../../src/remote-agent/agent-state.ts';
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
it('two actual native hello/ack lifecycles reconnect sequentially with generations1/2 and disconnected diagnostics',async()=>{
 const status=new RemoteAgentStatus(),stop=new AbortController(),generations:bigint[]=[],events:RemoteDisconnect[]=[];let retired=0;
 await runRemoteAgentLoop(0n,status,{connectAndServe:async(g,s,shutdown)=>{generations.push(g);let reads=0;await serveRemoteConnection('device',g,s,{beginConnection:async observed=>{assert.equal(observed,g);},send:async()=>{},receive:async()=>reads++===0?'{"type":"hello_ack"}':null,execute:async()=>{throw new Error('no command');},retireSessions:async()=>{retired++;assert.equal(s.isConnected(),true);}},shutdown);if(g===2n)stop.abort();},disconnected:async event=>{assert.equal(status.isConnected(),false);events.push(event);}},stop.signal);
 assert.deepEqual(generations,[1n,2n]);assert.equal(retired,2);assert.deepEqual(events,[{generation:1n,ok:true}]);assert.deepEqual(status.snapshot(),{connected:false,generation:2n});
});
it('connection failure is reported raw and retried without coercion or concurrent attempts',async()=>{
 const status=new RemoteAgentStatus(),stop=new AbortController();let hooks=0,calls=0;const failure={toString(){hooks++;return 'failure';}},events:RemoteDisconnect[]=[];
 await runRemoteAgentLoop(0n,status,{connectAndServe:async()=>{if(++calls===1)throw failure;stop.abort();},disconnected:async event=>{events.push(event);}},stop.signal);assert.equal(calls,2);assert.equal(hooks,0);assert.equal(events[0]?.ok,false);if(events[0]?.ok===false)assert.equal(events[0].error,failure);
});
it('shutdown waits for the actual connection owner before returning; no next attempt is started',async()=>{
 const status=new RemoteAgentStatus(),stop=new AbortController(),entered=deferred<void>(),gate=deferred<void>();let calls=0,done=false;
 const run=runRemoteAgentLoop(0n,status,{connectAndServe:async()=>{calls++;status.setConnected(1n);entered.resolve();await gate.promise;},disconnected:async()=>{throw new Error('no shutdown diagnostics');}},stop.signal).then(()=>{done=true;});await entered.promise;stop.abort();await tick();assert.equal(done,false);assert.equal(calls,1);gate.resolve();await run;assert.equal(status.isConnected(),false);
});
it('shutdown during maximal u64 reconnect delay stops safely without timer overflow retries',async()=>{
 const stop=new AbortController();let warning=false;const listener=(w:Error)=>{if(w.name==='TimeoutOverflowWarning')warning=true;};process.on('warning',listener);
 try{const waiting=waitRemoteReconnect(18446744073709551615n,stop.signal);await tick();stop.abort();assert.equal(await waiting,true);assert.equal(warning,false);}finally{process.removeListener('warning',listener);}
 assert.equal(await waitRemoteReconnect(0n,new AbortController().signal),false);
});
it('preabort has no port effects and diagnostic sink failure stops with status disconnected',async()=>{
 const status=new RemoteAgentStatus(),stop=new AbortController();stop.abort();let calls=0;await runRemoteAgentLoop(0n,status,{connectAndServe:async()=>{calls++;},disconnected:async()=>{calls++;}},stop.signal);assert.equal(calls,0);
 const failure=new Error('sink');await assert.rejects(runRemoteAgentLoop(0n,status,{connectAndServe:async()=>{status.setConnected(1n);},disconnected:async()=>{throw failure;}},new AbortController().signal),e=>e===failure);assert.equal(status.isConnected(),false);
});
it('active ports reject without executing accessors',async()=>{
 let calls=0;await assert.rejects(runRemoteAgentLoop(0n,new RemoteAgentStatus(),{get connectAndServe(){calls++;return async()=>{};},disconnected:async()=>{}},new AbortController().signal),TypeError);assert.equal(calls,0);
});
it('malformed non-Promise connection port is a contract failure, never a reconnectable transport result',async()=>{
 let calls=0,hooks=0,reports=0;const connect=(()=>{calls++;return {then(){hooks++;}};}) as unknown as (generation:bigint,status:RemoteAgentStatus,shutdown:AbortSignal)=>Promise<void>;
 await assert.rejects(runRemoteAgentLoop(0n,new RemoteAgentStatus(),{connectAndServe:connect,disconnected:async()=>{reports++;throw new Error('contract violation must not enter reconnect diagnostics');}},new AbortController().signal),e=>e instanceof TypeError&&e.message==='Remote runner port must return a Promise');assert.equal(calls,1);assert.equal(hooks,0);assert.equal(reports,0);
});
