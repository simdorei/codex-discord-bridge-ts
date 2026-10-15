import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from 'node:util';
import {once} from 'node:events';
import {WebSocketServer,type WebSocket} from 'ws';
import {SecretToken} from '../../src/config/remote.ts';
import {RemoteAgentStatus,RemoteAgentControl} from '../../src/remote-agent/agent-state.ts';
import {prepareManagedRemoteAgent,runManagedRemoteAgent,closePreparedManagedRemoteAgent,requestManagedRemoteStop,managedRemoteSnapshot,ManagedRemoteOwnershipRetainedError,type PreparedManagedRemoteAgent,type SyntheticManagedRemoteConfiguration} from '../../src/remote-agent/managed-agent.ts';
import type {RemoteProjectBackend,RemoteProjectBinding,RemoteSessionBackend} from '../../src/remote-agent/dispatcher-ports.ts';
const date=(seconds:bigint)=>Object.freeze({seconds,nanosecond:0n});
const binding=(threadId='t',seconds=300n)=>Object.freeze({threadId,root:'/synthetic/'+threadId,expiresAt:date(seconds)});
const deferred=<T=void>()=>{let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const wire=(type:string,extra:object={})=>JSON.stringify({type,request_id:'r',thread_id:'t',computer_session_id:'abcdefghijklmnop',deadline_at:'1970-01-01T00:03:20Z',...(type==='project_session'?{computer_session_generation:1}:{}),...(type==='write_file'?{path:'a',content:'x'}:{}),...extra});
function fixture(url='ws://127.0.0.1:1'){
 const events:string[]=[],status=new RemoteAgentStatus(),control=new RemoteAgentControl();let opens=0,creates=0,writes=0,now=100n,protectedBindings:readonly RemoteProjectBinding[]|null=null;
 const session:RemoteSessionBackend={stopComputer:async()=>{events.push('computer');},closeTerminalWindows:async()=>{events.push('windows');},closeTerminals:async()=>{events.push('terminals');},computer:null,terminal:null,terminalWindow:null};
 const backend:RemoteProjectBackend={close:async()=>{events.push('project');},createSession:async()=>{creates++;return session;},listFiles:null,readFile:null,writeFile:async c=>{writes++;return Object.freeze({path:c.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});},core:null};
 const input:SyntheticManagedRemoteConfiguration={kind:'SyntheticManagedRemote',socket:{bridgeUrl:url,deviceId:'fixture-device',deviceToken:new SecretToken('synthetic-managed-fixture')},reconnectDelaySeconds:0n,status,control,dispatcher:{openProject:async()=>{opens++;events.push('open');return backend;},nowUtc:()=>date(now),nowMonotonic:()=>0n},handoff:{kind:'SyntheticProtectedBindingPorts',restore:async()=>{events.push('restore');return Object.freeze([binding()]);},protect:async values=>{events.push('protect');protectedBindings=values;}},disconnected:async event=>{events.push('disconnect:'+event.generation);}};
 return {input,events,status,control,backend,session,counts:()=>({opens,creates,writes}),setNow:(value:bigint)=>{now=value;},protected:()=>protectedBindings};
}
async function server(t:TestContext,connected:(peer:WebSocket)=>void){
 const ws=new WebSocketServer({host:'127.0.0.1',port:0,perMessageDeflate:false});const closes:Promise<void>[]=[];ws.on('connection',(peer,request)=>{assert.equal(request.headers.authorization,'Bearer synthetic-managed-fixture');closes.push(new Promise<void>(r=>peer.once('close',()=>r())));connected(peer);});await once(ws,'listening');
 t.after(async()=>{for(const peer of ws.clients)peer.terminate();await new Promise<void>(r=>ws.close(()=>r()));});return {url:`ws://127.0.0.1:${(ws.address() as {port:number}).port}`,joined:()=>Promise.all(closes)};
}
function change<T extends object,K extends keyof T>(target:T,key:K,value:T[K]){(target as {-readonly [P in keyof T]:T[P]})[key]=value;}
test('preabort and passive invalid profiles fail before restore or resources',async()=>{
 const f=fixture(),stop=new AbortController();stop.abort();await assert.rejects(prepareManagedRemoteAgent(f.input,stop.signal));assert.deepEqual(f.events,[]);
 const signal=new AbortController().signal;let hooks=0;
 await assert.rejects(prepareManagedRemoteAgent({...f.input,get socket(){hooks++;return f.input.socket;}},signal),TypeError);
 await assert.rejects(prepareManagedRemoteAgent(new Proxy(f.input,{get(){hooks++;throw Error('proxy');}}),signal),TypeError);
 for(const url of ['wss://example.com','ws://localhost:3','ws://127.0.0.1:3/#','ws://u:p@127.0.0.1:3'])await assert.rejects(prepareManagedRemoteAgent({...f.input,socket:{...f.input.socket,bridgeUrl:url}},signal));
 await assert.rejects(prepareManagedRemoteAgent({...f.input,socket:{...f.input.socket,deviceToken:new SecretToken('not-a-synthetic-token')}},signal));assert.equal(hooks,0);assert.deepEqual(f.events,[]);
});
test('authentic prepared owner rejects foreign, copied, proxied and reused receipts before effects',async()=>{
 const f=fixture(),signal=new AbortController().signal,owner=await prepareManagedRemoteAgent(f.input,signal),before=[...f.events];
 for(const forged of [{}, {...owner},new Proxy(owner,{})]){assert.throws(()=>runManagedRemoteAgent(forged as PreparedManagedRemoteAgent,signal),TypeError);assert.throws(()=>closePreparedManagedRemoteAgent(forged as PreparedManagedRemoteAgent),TypeError);}assert.deepEqual(f.events,before);
 const receipt=closePreparedManagedRemoteAgent(owner);assert.equal(closePreparedManagedRemoteAgent(owner),receipt);await receipt;assert.throws(()=>runManagedRemoteAgent(owner,signal),/already claimed/);assert.equal(managedRemoteSnapshot(owner).phase,'closed');
});
test('shared status and control clones belong to one managed lifetime before restore effects',async()=>{
 const f=fixture(),finish=deferred<readonly RemoteProjectBinding[]>(),signal=new AbortController().signal;let restores=0;
 change(f.input.handoff,'restore',async()=>{restores++;return finish.promise;});const first=prepareManagedRemoteAgent(f.input,signal);
 for(const input of [f.input,{...f.input,status:f.status.clone(),control:f.control.clone()},{...f.input,status:new RemoteAgentStatus()},{...f.input,control:new RemoteAgentControl()}])await assert.rejects(prepareManagedRemoteAgent(input,signal),/already belongs/);
 assert.equal(restores,1);finish.resolve(Object.freeze([binding()]));const owner=await first;await closePreparedManagedRemoteAgent(owner);await assert.rejects(prepareManagedRemoteAgent(f.input,signal),/already belongs/);assert.equal(restores,1);
 // A rejected combination must not consume either otherwise-unclaimed state.
 const status=new RemoteAgentStatus(),control=new RemoteAgentControl();await assert.rejects(prepareManagedRemoteAgent({...f.input,status},signal),/already belongs/);const next=await prepareManagedRemoteAgent({...f.input,status,control},signal);await closePreparedManagedRemoteAgent(next);
});
test('failed restore consumes shared state and cannot silently retry initialization',async()=>{
 const f=fixture(),signal=new AbortController().signal;let restores=0;change(f.input.handoff,'restore',async()=>{restores++;throw Error('restore failed');});await assert.rejects(prepareManagedRemoteAgent(f.input,signal),/restore failed/);await assert.rejects(prepareManagedRemoteAgent({...f.input,status:f.status.clone(),control:f.control.clone()},signal),/already belongs/);assert.equal(restores,1);
});
test('restore is joined once before preparation returns and socket opens only when run starts',{timeout:10000},async t=>{
 const restored=deferred<readonly RemoteProjectBinding[]>();let connected=0;const stop=new AbortController(),s=await server(t,peer=>{connected++;peer.once('message',()=>{peer.send('{"type":"hello_ack"}');stop.abort();});}),f=fixture(s.url);
 change(f.input.handoff,'restore',async()=>{f.events.push('restore');return restored.promise;});const preparing=prepareManagedRemoteAgent(f.input,stop.signal);await tick();assert.equal(connected,0);assert.deepEqual(f.events,['restore']);restored.resolve(Object.freeze([binding()]));const owner=await preparing;assert.equal(connected,0);await runManagedRemoteAgent(owner,stop.signal);await s.joined();assert.equal(connected,1);assert.equal(f.events.filter(e=>e==='restore').length,1);assert.equal(f.counts().opens,1);
});
test('restore failure joins earlier accepted project cleanup and never dials',async()=>{
 const f=fixture(),started=deferred(),finish=deferred(),failure=Error('second restore failed');let count=0;
 change(f.input.handoff,'restore',async()=>Object.freeze([binding('a'),binding('b')]));change(f.backend,'close',async()=>{started.resolve();await finish.promise;f.events.push('project');});change(f.input.dispatcher,'openProject',async()=>{if(++count===2)throw failure;return f.backend;});
 let settled=false;const pending=prepareManagedRemoteAgent(f.input,new AbortController().signal).catch(error=>{settled=true;throw error;});const rejection=assert.rejects(pending,error=>error===failure);await started.promise;await tick();assert.equal(settled,false);finish.resolve();await rejection;assert.deepEqual(f.events,['project']);
});
test('initialization cleanup failure retains an inspectable authentic owner without retry',async()=>{
 const f=fixture();let closes=0;change(f.input.handoff,'restore',async()=>Object.freeze([binding('a'),binding('b')]));let opens=0;change(f.input.dispatcher,'openProject',async()=>{if(++opens===2)throw Error('restore');return f.backend;});change(f.backend,'close',async()=>{closes++;throw Error('close');});
 await assert.rejects(prepareManagedRemoteAgent(f.input,new AbortController().signal),error=>{assert.ok(error instanceof ManagedRemoteOwnershipRetainedError);assert.equal(managedRemoteSnapshot(error.owner).phase,'retained');assert.equal(managedRemoteSnapshot(error.owner).dispatcher.failedProjectCleanups,1);assert.throws(()=>runManagedRemoteAgent(error.owner,new AbortController().signal),/already claimed/);return true;});assert.equal(closes,1);
});
test('restore rejects excess, duplicate, mutable and malformed binding data before opening any project',async()=>{
 const cases:readonly unknown[]=[Object.freeze(Array.from({length:17},(_,i)=>binding(String(i)))),Object.freeze([binding(),binding()]),[binding()],Object.freeze([{threadId:'t',root:'/synthetic/t',expiresAt:date(300n)}])];
 for(const value of cases){const f=fixture();change(f.input.handoff,'restore',async()=>value as readonly RemoteProjectBinding[]);await assert.rejects(prepareManagedRemoteAgent(f.input,new AbortController().signal));assert.equal(f.counts().opens,0);}
});
test('captured config, backend and handoff functions cannot be retargeted after preparation',{timeout:10000},async t=>{
 const stop=new AbortController(),s=await server(t,peer=>peer.once('message',raw=>{assert.equal(JSON.parse(raw.toString()).device_id,'fixture-device');peer.send('{"type":"hello_ack"}');stop.abort();})),f=fixture(s.url),owner=await prepareManagedRemoteAgent(f.input,stop.signal);
 change(f.input.socket,'bridgeUrl','ws://127.0.0.1:1');change(f.input.socket,'deviceId','changed');change(f.input.handoff,'protect',async()=>assert.fail('retargeted'));change(f.backend,'close',async()=>assert.fail('retargeted backend'));
 f.control.requestRestartHandoff();await runManagedRemoteAgent(owner,stop.signal);await s.joined();assert.equal(managedRemoteSnapshot(owner).handoffPrepared,true);assert.deepEqual(f.events,['restore','open','project','protect']);assert.ok(!inspect(owner).includes('synthetic-managed-fixture'));assert.ok(!inspect(managedRemoteSnapshot(owner)).includes('synthetic-managed-fixture'));
});
test('same real dispatcher survives reconnect and mutation cache still requires fresh session acknowledgement',{timeout:15000},async t=>{
 let connection=0;const stop=new AbortController(),observed:string[]=[],s=await server(t,peer=>{const current=++connection;peer.on('message',raw=>{const message=JSON.parse(raw.toString());observed.push(current+':'+message.type);if(message.type==='hello'){peer.send('{"type":"hello_ack"}');peer.send(wire('project_info',{request_id:'before'}));}else if(message.request_id==='before'){assert.equal(message.error_code,'computer_control');peer.send(wire('project_session',{request_id:'session'}));}else if(message.request_id==='session'){peer.send(wire('write_file'));}else{assert.equal(message.type,'write_file_result');if(current===2)stop.abort();else peer.close();}});}),f=fixture(s.url),owner=await prepareManagedRemoteAgent(f.input,stop.signal);
 await runManagedRemoteAgent(owner,stop.signal);await s.joined();assert.equal(connection,2);assert.deepEqual(f.counts(),{opens:1,creates:2,writes:1});assert.equal(f.status.generation(),2n);assert.equal(f.status.isConnected(),false);assert.equal(f.events.filter(e=>e==='disconnect:1').length,1);assert.equal(f.events.at(-1),'project');assert.equal(observed.filter(e=>e.endsWith(':hello')).length,2);
});
test('status connects only after hello ack and disconnect waits accepted native operation and session joins',{timeout:15000},async t=>{
 const hello=deferred(),started=deferred(),finish=deferred(),cleaning=deferred(),cleaned=deferred();let peer!:WebSocket,signal:AbortSignal|undefined;const stop=new AbortController(),s=await server(t,p=>{peer=p;p.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.type==='hello')hello.resolve();else if(message.type==='project_session_result')p.send(wire('write_file'));});}),f=fixture(s.url);
 change(f.backend,'writeFile',async(c,context)=>{signal=context.signal;started.resolve();await finish.promise;return Object.freeze({path:c.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});});change(f.session,'stopComputer',async()=>{cleaning.resolve();await cleaned.promise;f.events.push('computer');});
 const owner=await prepareManagedRemoteAgent(f.input,stop.signal);let done=false;const running=runManagedRemoteAgent(owner,stop.signal).then(()=>{done=true;});await hello.promise;assert.equal(f.status.isConnected(),false);peer.send('{"type":"hello_ack"}');peer.send(wire('project_session'));await started.promise;assert.equal(f.status.isConnected(),true);
 stop.abort();await tick();assert.equal(signal!.aborted,true);assert.equal(done,false);assert.equal(f.events.includes('computer'),false);finish.resolve();await cleaning.promise;assert.equal(done,false);assert.equal(f.status.isConnected(),true);f.control.requestRestartHandoff();cleaned.resolve();await running;await s.joined();assert.deepEqual(f.events.slice(-5),['computer','windows','terminals','project','protect']);assert.equal(managedRemoteSnapshot(owner).handoffPrepared,true);
});
test('normal stop never protects; request after managed completion is too late',async()=>{
 const f=fixture(),signal=new AbortController().signal,owner=await prepareManagedRemoteAgent(f.input,signal);requestManagedRemoteStop(owner);await runManagedRemoteAgent(owner,signal);f.control.requestRestartHandoff();requestManagedRemoteStop(owner);assert.equal(managedRemoteSnapshot(owner).handoffRequested,false);assert.equal(f.protected(),null);assert.throws(()=>runManagedRemoteAgent(owner,signal),/already claimed/);
});
test('handoff decision seals after loop joins, before project close; late close-stage flag does not persist',async()=>{
 const f=fixture(),started=deferred(),finish=deferred();change(f.backend,'close',async()=>{started.resolve();await finish.promise;});const signal=new AbortController().signal,owner=await prepareManagedRemoteAgent(f.input,signal);requestManagedRemoteStop(owner);const running=runManagedRemoteAgent(owner,signal);await started.promise;f.control.requestRestartHandoff();finish.resolve();await running;assert.equal(f.protected(),null);assert.equal(managedRemoteSnapshot(owner).handoffRequested,false);
});
test('snapshot is sorted binding-only, filters expiry at preparation now, and empty skips protect',async()=>{
 for(const now of [200n,500n]){const f=fixture();change(f.input.handoff,'restore',async()=>Object.freeze([binding('z'),binding('expired',150n),binding('a')]));const signal=new AbortController().signal,owner=await prepareManagedRemoteAgent(f.input,signal);f.setNow(now);f.control.requestRestartHandoff();requestManagedRemoteStop(owner);await runManagedRemoteAgent(owner,signal);assert.deepEqual(f.protected(),now===500n?null:Object.freeze([binding('a'),binding('z')]));if(f.protected())assert.deepEqual(Object.keys(f.protected()![0]!),['threadId','root','expiresAt']);}
});
test('binding snapshot order matches Rust UTF-8 order across BMP and astral IDs',async()=>{
 const f=fixture();change(f.input.handoff,'restore',async()=>Object.freeze([binding('\u{10000}'),binding('\uE000'),binding('a')]));const signal=new AbortController().signal,owner=await prepareManagedRemoteAgent(f.input,signal);f.control.requestRestartHandoff();requestManagedRemoteStop(owner);await runManagedRemoteAgent(owner,signal);assert.deepEqual(f.protected()!.map(value=>value.threadId),['a','\uE000','\u{10000}']);
});
test('bindings expiring during joined project cleanup are filtered again before protection',async()=>{
 const f=fixture();change(f.backend,'close',async()=>{f.setNow(300n);f.events.push('project');});const signal=new AbortController().signal,owner=await prepareManagedRemoteAgent(f.input,signal);f.control.requestRestartHandoff();requestManagedRemoteStop(owner);await runManagedRemoteAgent(owner,signal);assert.equal(f.protected(),null);assert.equal(managedRemoteSnapshot(owner).handoffPrepared,false);assert.equal(managedRemoteSnapshot(owner).phase,'closed');
});
test('protect is joined exactly once after project release and failure propagates without a retry',async()=>{
 const f=fixture(),started=deferred(),finish=deferred(),failure=Error('synthetic protected persistence failed');let calls=0;change(f.input.handoff,'protect',async()=>{calls++;assert.equal(f.events.at(-1),'project');started.resolve();await finish.promise;throw failure;});const signal=new AbortController().signal,owner=await prepareManagedRemoteAgent(f.input,signal);f.control.requestRestartHandoff();requestManagedRemoteStop(owner);const running=runManagedRemoteAgent(owner,signal),rejection=assert.rejects(running,error=>error===failure);await started.promise;assert.equal(managedRemoteSnapshot(owner).phase,'protecting');assert.equal(closePreparedManagedRemoteAgent(owner),running);finish.resolve();await rejection;assert.equal(calls,1);assert.equal(managedRemoteSnapshot(owner).phase,'closed');assert.equal(managedRemoteSnapshot(owner).handoffPrepared,false);
});
test('final project cleanup failure prevents protection and retains its failed ownership receipt',async()=>{
 const f=fixture();let closes=0;change(f.backend,'close',async()=>{closes++;throw Error('cannot close');});const signal=new AbortController().signal,owner=await prepareManagedRemoteAgent(f.input,signal);f.control.requestRestartHandoff();requestManagedRemoteStop(owner);const running=runManagedRemoteAgent(owner,signal);await assert.rejects(running,ManagedRemoteOwnershipRetainedError);assert.equal(closePreparedManagedRemoteAgent(owner),running);await assert.rejects(closePreparedManagedRemoteAgent(owner));assert.equal(closes,1);assert.equal(f.protected(),null);assert.equal(managedRemoteSnapshot(owner).phase,'retained');
});
test('diagnostic failure propagates after native socket release and project close',{timeout:10000},async t=>{
 const failure=Error('diagnostic failed'),s=await server(t,peer=>peer.once('message',()=>peer.close())),f=fixture(s.url);change(f.input,'disconnected',async event=>{assert.equal(event.ok,false);assert.equal(f.status.isConnected(),false);throw failure;});const owner=await prepareManagedRemoteAgent(f.input,new AbortController().signal);await assert.rejects(runManagedRemoteAgent(owner,new AbortController().signal),error=>error===failure);await s.joined();assert.equal(f.events.at(-1),'project');assert.equal(managedRemoteSnapshot(owner).phase,'closed');
});
test('actual command loop retains four active/sixteen total and joins cancelled uncollected work',{timeout:20000},async t=>{
 const four=deferred(),busy=deferred(),finish=deferred(),stop=new AbortController();let active=0,maximum=0,calls=0,busyCount=0;const signals:AbortSignal[]=[];
 const s=await server(t,peer=>peer.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.type==='hello'){peer.send('{"type":"hello_ack"}');peer.send(wire('project_session'));}else if(message.type==='project_session_result'){for(let i=0;i<18;i++)peer.send(wire('read_file',{request_id:String(i),path:'a',start_line:1,max_lines:10}));}else if(message.error_code==='bridge_busy'){if(++busyCount===2)busy.resolve();}})),f=fixture(s.url);
 change(f.backend,'readFile',async(_command,context)=>{calls++;active++;maximum=Math.max(maximum,active);signals.push(context.signal);if(active===4)four.resolve();try{await finish.promise;return Object.freeze({path:'a',content:'x',sha256:'a'.repeat(64),start_line:1n,end_line:1n,total_lines:1n,truncated:false,redacted:false});}finally{active--;}});
 const owner=await prepareManagedRemoteAgent(f.input,stop.signal);let done=false;const running=runManagedRemoteAgent(owner,stop.signal).then(()=>{done=true;});assert.throws(()=>runManagedRemoteAgent(owner,stop.signal),/already claimed/);assert.throws(()=>closePreparedManagedRemoteAgent(owner),/already active/);
 await four.promise;await busy.promise;assert.equal(calls,4);assert.equal(maximum,4);assert.equal(managedRemoteSnapshot(owner).dispatcher.accepted,4);stop.abort();await tick();assert.equal(signals.every(signal=>signal.aborted),true);assert.equal(done,false);assert.equal(f.events.includes('project'),false);
 finish.resolve();await running;await s.joined();assert.equal(active,0);assert.equal(calls,4);assert.equal(busyCount,2);assert.equal(managedRemoteSnapshot(owner).dispatcher.accepted,0);assert.equal(managedRemoteSnapshot(owner).dispatcher.retainedCommandBytes,0);
});
test('reconnect cannot open another socket while earlier session cleanup is pending',{timeout:15000},async t=>{
 const cleaning=deferred(),release=deferred(),stop=new AbortController();let connections=0,closes=0;
 const s=await server(t,peer=>{const number=++connections;peer.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.type==='hello'){peer.send('{"type":"hello_ack"}');peer.send(wire('project_session'));}else if(message.type==='project_session_result'){if(number===1)peer.close();else stop.abort();}});}),f=fixture(s.url);
 change(f.session,'stopComputer',async()=>{if(++closes===1){cleaning.resolve();await release.promise;}f.events.push('computer');});const owner=await prepareManagedRemoteAgent(f.input,stop.signal),running=runManagedRemoteAgent(owner,stop.signal);await cleaning.promise;await tick();assert.equal(connections,1);assert.equal(f.events.includes('disconnect:1'),false);release.resolve();await running;await s.joined();assert.equal(connections,2);assert.equal(closes,2);assert.equal(f.counts().opens,1);
});
test('session retirement failure is terminal, retains failed cleanup and never reconnects',{timeout:10000},async t=>{
 let connections=0,closes=0;const s=await server(t,peer=>{connections++;peer.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.type==='hello'){peer.send('{"type":"hello_ack"}');peer.send(wire('project_session'));}else peer.close();});}),f=fixture(s.url);
 change(f.session,'stopComputer',async()=>{closes++;throw Error('native session cleanup failed');});const owner=await prepareManagedRemoteAgent(f.input,new AbortController().signal);await assert.rejects(runManagedRemoteAgent(owner,new AbortController().signal),ManagedRemoteOwnershipRetainedError);await s.joined();assert.equal(connections,1);assert.equal(closes,1);assert.equal(f.events.includes('disconnect:1'),false);assert.equal(managedRemoteSnapshot(owner).dispatcher.failedSessionCleanups,1);assert.equal(managedRemoteSnapshot(owner).phase,'retained');assert.equal(f.protected(),null);
});
test('handoff Promise contract never assimilates a thenable or executes its getter',async()=>{
 let hooks=0;const thenable=Object.freeze({get then(){hooks++;throw Error('then getter');}}),f=fixture();change(f.input.handoff,'restore',(()=>thenable) as unknown as typeof f.input.handoff.restore);await assert.rejects(prepareManagedRemoteAgent(f.input,new AbortController().signal),/must return a Promise/);assert.equal(hooks,0);assert.equal(f.counts().opens,0);
 const g=fixture();change(g.input.handoff,'protect',(()=>thenable) as unknown as typeof g.input.handoff.protect);const signal=new AbortController().signal,owner=await prepareManagedRemoteAgent(g.input,signal);g.control.requestRestartHandoff();requestManagedRemoteStop(owner);await assert.rejects(runManagedRemoteAgent(owner,signal),/must return a Promise/);assert.equal(hooks,0);assert.equal(managedRemoteSnapshot(owner).phase,'closed');
});
test('managed and configured callbacks cannot inspect owner state, credentials or dispatcher through this',{timeout:15000},async t=>{
 const stop=new AbortController(),seen=new Set<string>();let connections=0;
 const s=await server(t,peer=>{const number=++connections;peer.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.type==='hello'){peer.send('{"type":"hello_ack"}');peer.send(wire('project_session'));}else if(message.type==='project_session_result'){peer.send(wire('write_file'));}else if(message.type==='write_file_result'){peer.send(wire('read_file',{path:'a',start_line:1,max_lines:10}));}else if(message.type==='read_file_result'){if(number===1)peer.close();else stop.abort();}});}),f=fixture(s.url);
 const detached=(receiver:unknown,name:string)=>{assert.equal(receiver,undefined,name+' must not receive owner state');seen.add(name);};
 const leaf=(receiver:unknown,name:string)=>{assert.equal(Object.isFrozen(receiver),true);assert.deepEqual(Object.keys(receiver as object).sort(),['close','createSession','listFiles','readFile','writeFile','core'].sort());seen.add(name);};
 change(f.input.handoff,'restore',async function(this:unknown){detached(this,'restore');return Object.freeze([binding()]);});
 change(f.input.handoff,'protect',async function(this:unknown,bindings){detached(this,'protect');assert.deepEqual(bindings,[binding()]);});
 change(f.input,'disconnected',async function(this:unknown){detached(this,'disconnected');});
 change(f.input.dispatcher,'openProject',async function(this:unknown){detached(this,'openProject');return f.backend;});
 change(f.input.dispatcher,'nowUtc',function(this:unknown){detached(this,'nowUtc');return date(100n);});
 change(f.input.dispatcher,'nowMonotonic',function(this:unknown){detached(this,'nowMonotonic');return 0n;});
 change(f.backend,'createSession',async function(this:unknown){leaf(this,'createSession');return f.session;});
 change(f.backend,'close',async function(this:unknown){leaf(this,'close');});
 change(f.backend,'writeFile',async function(this:unknown,c){leaf(this,'writeFile');return Object.freeze({path:c.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});});
 change(f.backend,'readFile',async function(this:unknown){leaf(this,'readFile');return Object.freeze({path:'a',content:'x',sha256:'a'.repeat(64),start_line:1n,end_line:1n,total_lines:1n,truncated:false,redacted:false});});
 change(f.session,'stopComputer',async function(this:unknown){detached(this,'stopComputer');});
 change(f.session,'closeTerminalWindows',async function(this:unknown){detached(this,'closeTerminalWindows');});
 change(f.session,'closeTerminals',async function(this:unknown){detached(this,'closeTerminals');});
 const owner=await prepareManagedRemoteAgent(f.input,stop.signal);f.control.requestRestartHandoff();await runManagedRemoteAgent(owner,stop.signal);await s.joined();assert.equal(connections,2);
 assert.deepEqual([...seen].sort(),['restore','protect','disconnected','openProject','nowUtc','nowMonotonic','createSession','close','writeFile','readFile','stopComputer','closeTerminalWindows','closeTerminals'].sort());
});
