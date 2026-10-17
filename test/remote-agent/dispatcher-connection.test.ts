import {it} from 'node:test';
import assert from 'node:assert/strict';
import {createRemoteDispatcherConnection} from '../../src/remote-agent/dispatcher-connection.ts';
import {RemoteProjectDispatcher} from '../../src/remote-agent/project-dispatcher.ts';
import {parseGatewayCommand} from '../../src/remote-agent/gateway-command.ts';
const command=()=>parseGatewayCommand('{"type":"project_info","request_id":"r","thread_id":"t"}',1048576,0);
const owner=()=>new RemoteProjectDispatcher({openProject:async()=>{throw new Error('Unexpected project open');},nowUtc:()=>({seconds:0n,nanosecond:0n}),nowMonotonic:()=>0n});
it('authenticates the actual dispatcher before creating an adapter',()=>{
 assert.throws(()=>createRemoteDispatcherConnection({} as RemoteProjectDispatcher,1n),TypeError);
 assert.throws(()=>createRemoteDispatcherConnection(new Proxy(owner(),{}),1n),TypeError);
 assert.throws(()=>createRemoteDispatcherConnection(owner(),-1n),RangeError);
});
it('attempt rejects pre-begin, wrong-generation, duplicate begin and post-retire operations',async()=>{
 const d=owner(),a=createRemoteDispatcherConnection(d,1n),signal=new AbortController().signal;
 await assert.rejects(a.execute(command(),1n,signal),/no active/);
 await assert.rejects(a.beginConnection(2n),/generation differs/);
 await a.beginConnection(1n);await assert.rejects(a.beginConnection(1n),/already claimed/);
 await assert.rejects(a.execute(command(),2n,signal),/no active/);
 assert.equal((await a.execute(command(),1n,signal)).type,'operation_error');
 const retired=a.retireSessions();assert.equal(a.retireSessions(),retired);await retired;
 await assert.rejects(a.execute(command(),1n,signal),/no active/);await d.close();
});
it('failed begin and late previous retirement never retire another attempt receipt',async()=>{
 const d=owner(),first=createRemoteDispatcherConnection(d,1n);await first.beginConnection(1n);
 const failed=createRemoteDispatcherConnection(d,1n);await assert.rejects(failed.beginConnection(1n),/already owned/);await failed.retireSessions();assert.equal(d.snapshot().generation,1n);
 await first.retireSessions();const next=createRemoteDispatcherConnection(d,2n);await next.beginConnection(2n);
 await first.retireSessions();await failed.retireSessions();assert.equal(d.snapshot().generation,2n);
 await assert.rejects(first.execute(command(),1n,new AbortController().signal),/no active/);await next.retireSessions();await d.close();
});
it('concurrent and reused attempts reject without replacing a live connection',async()=>{
 const d=owner(),first=createRemoteDispatcherConnection(d,1n),other=createRemoteDispatcherConnection(d,2n);await first.beginConnection(1n);
 await assert.rejects(other.beginConnection(2n),/already owned/);await other.retireSessions();assert.equal(d.snapshot().generation,1n);await first.retireSessions();
 const stale=createRemoteDispatcherConnection(d,1n);await assert.rejects(stale.beginConnection(1n),/did not advance/);await stale.retireSessions();
 const next=createRemoteDispatcherConnection(d,2n);await next.beginConnection(2n);await next.retireSessions();await d.close();
});
it('retire called during begin waits for its receipt, and retiring an unused adapter closes admission',async()=>{
 const d=owner(),a=createRemoteDispatcherConnection(d,1n),begin=a.beginConnection(1n),retire=a.retireSessions();await begin;await retire;assert.equal(d.snapshot().generation,null);
 const unused=createRemoteDispatcherConnection(d,2n);await unused.retireSessions();await assert.rejects(unused.beginConnection(2n),/already claimed/);await d.close();
});
