import {it} from 'node:test';
import assert from 'node:assert/strict';
import {RemoteProjectDispatcher,type RemoteDispatcherConnection} from '../../src/remote-agent/project-dispatcher.ts';
import type {RemoteProjectBackend,RemoteSessionBackend,RemoteOperationContext} from '../../src/remote-agent/dispatcher-ports.ts';
import {parseGatewayCommand,type GatewayCommand} from '../../src/remote-agent/gateway-command.ts';
import type {BridgeResult} from '../../src/remote-agent/bridge-inbound.ts';
import {RemoteWorkerCapacityError} from '../../src/remote-agent/bounded-workers.ts';
const SID='abcdefghijklmnop',OTHER='qrstuvwxyzabcdef';
const date=(seconds:bigint)=>Object.freeze({seconds,nanosecond:0n});
const deferred=<T=void>()=>{let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const command=(type='project_session',extra:object={}):GatewayCommand=>parseGatewayCommand(JSON.stringify({type,request_id:'r',thread_id:'t',computer_session_id:SID,deadline_at:'1970-01-01T00:03:20Z',...(type==='project_session'||type==='device_session'?{computer_session_generation:1}:{}),...(type==='device_session'?{working_directory:'/synthetic/project',expires_at:'1970-01-01T00:05:00Z'}:{}),...(type==='write_file'?{path:'a',content:'x'}:{}),...extra}),1048576,0);
const error=(result:BridgeResult,code:string,message?:RegExp)=>{assert.equal(result.type,'operation_error');if(result.type==='operation_error'){assert.equal(result.error_code,code);if(message)assert.match(result.message,message);}};
function fixture(){
 const events:string[]=[];let now=100n,opens=0,creates=0,writes=0;
 let write:NonNullable<RemoteProjectBackend['writeFile']>=async c=>Object.freeze({path:c.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});
 let make:NonNullable<RemoteProjectBackend['createSession']>=async()=>({stopComputer:async()=>{events.push('computer');},closeTerminalWindows:async()=>{events.push('windows');},closeTerminals:async()=>{events.push('terminals');},computer:null,terminal:null,terminalWindow:null});
 const backend:RemoteProjectBackend={close:async()=>{events.push('project');},createSession:async identity=>{creates++;return make(identity);},listFiles:null,readFile:null,writeFile:async(c,x)=>{writes++;return write(c,x);},core:null};
 const config={openProject:async()=>{opens++;return backend;},nowUtc:()=>date(now),nowMonotonic:()=>0n};
 const owner=new RemoteProjectDispatcher(config);
 return {owner,backend,config,events,setNow:(v:bigint)=>{now=v;},setWrite:(v:typeof write)=>{write=v;},setSession:(v:typeof make)=>{make=v;},counts:()=>({opens,creates,writes}),bind:()=>owner.upsert(Object.freeze({threadId:'t',root:'/synthetic/project',expiresAt:date(300n)}))};
}
const execute=(owner:RemoteProjectDispatcher,c:GatewayCommand,connection:RemoteDispatcherConnection,signal=new AbortController().signal)=>owner.execute(c,connection,signal);
async function active(f:ReturnType<typeof fixture>){await f.bind();const c=await f.owner.beginConnection(1n);assert.equal((await execute(f.owner,command(),c)).type,'project_session_result');return c;}

it('missing binding precedes deadline, deadline precedes binding expiry, and cancellation precedes device upsert',async()=>{
 const f=fixture(),c=await f.owner.beginConnection(1n);f.setNow(400n);
 error(await execute(f.owner,command('project_info'),c),'binding_missing');
 await f.bind();error(await execute(f.owner,command('project_info'),c),'request_expired');
 error(await execute(f.owner,command('project_info',{deadline_at:'1970-01-01T00:10:00Z'}),c),'binding_expired');
 const stop=new AbortController();stop.abort();const before=f.counts().opens;
 error(await execute(f.owner,command('device_session'),c,stop.signal),'request_cancelled');assert.equal(f.counts().opens,before);await f.owner.close();
});
it('device binding upsert intentionally precedes deadline evaluation',async()=>{
 const f=fixture(),c=await f.owner.beginConnection(1n);f.setNow(250n);
 error(await execute(f.owner,command('device_session'),c),'request_expired');assert.equal(f.counts().opens,1);assert.equal(f.owner.snapshot().projects,1);assert.equal(f.counts().creates,0);await f.owner.close();
});
it('device project-open failure uses the existing file-error mapping',async()=>{
 const f=fixture();f.config.openProject=async()=>{throw new Error('synthetic open error');};
 const owner=new RemoteProjectDispatcher(f.config),c=await owner.beginConnection(1n);
 error(await execute(owner,command('device_session'),c),'projectfile',/synthetic open error/);assert.equal(owner.snapshot().projects,0);await owner.close();
});
it('owned connection receipts reject copies, proxies, cross-owner receipts and stale generations',async()=>{
 const f=fixture(),c=await active(f),other=fixture(),foreign=await other.owner.beginConnection(1n);
 assert.throws(()=>execute(f.owner,command(),{...c}),/Foreign or forged/);
 assert.throws(()=>execute(f.owner,command(),new Proxy(c,{})),/Foreign or forged/);
 assert.throws(()=>execute(f.owner,command(),foreign),/Foreign or forged/);
 await assert.rejects(f.owner.beginConnection(1n),/did not advance/);
 await f.owner.retireConnection(c);await assert.rejects(f.owner.beginConnection(1n),/did not advance/);
 const next=await f.owner.beginConnection(2n);error(await execute(f.owner,command(),c),'computer_control',/stale local bridge/);assert.equal(f.counts().creates,1);
 assert.equal((await execute(f.owner,command(),next)).type,'project_session_result');await f.owner.close();await other.owner.close();
});
it('activation preserves lower-generation, conflicting-ID and mode precedence without allocating',async()=>{
 const f=fixture(),c=await active(f);
 assert.equal((await execute(f.owner,command(),c)).type,'project_session_result');assert.equal(f.counts().creates,1);
 error(await execute(f.owner,command('project_session',{computer_session_generation:1,computer_session_id:OTHER}),c),'computer_control',/conflicts with another/);
 assert.equal((await execute(f.owner,command('project_session',{computer_session_generation:2}),c)).type,'project_session_result');
 error(await execute(f.owner,command(),c),'computer_control',/older than/);assert.equal(f.counts().creates,2);
 assert.equal((await execute(f.owner,command('device_session'),c)).type,'project_session_result');
 error(await execute(f.owner,command(),c),'computer_control',/mode conflicts/);assert.equal(f.counts().creates,3);await f.owner.close();
});
it('unacknowledged or mismatched sessions cannot reach leaf operations',async()=>{
 const f=fixture();await f.bind();const c=await f.owner.beginConnection(1n);
 error(await execute(f.owner,command('write_file'),c),'computer_control',/not acknowledged/);
 await execute(f.owner,command(),c);error(await execute(f.owner,command('write_file',{computer_session_id:OTHER}),c),'computer_control',/not acknowledged/);assert.equal(f.counts().writes,0);await f.owner.close();
});
it('concurrent duplicate mutation executes once and conflicting content is not executed',async()=>{
 const f=fixture(),c=await active(f),started=deferred(),finish=deferred();
 f.setWrite(async command=>{started.resolve();await finish.promise;return Object.freeze({path:command.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});});
 const first=execute(f.owner,command('write_file'),c);await started.promise;
 const duplicate=execute(f.owner,command('write_file',{deadline_at:'1970-01-01T00:03:21Z'}),c),conflict=execute(f.owner,command('write_file',{content:'different'}),c);finish.resolve();
 assert.equal((await first).type,'write_file_result');assert.deepEqual(await duplicate,await first);error(await conflict,'request_id_conflict');assert.equal(f.counts().writes,1);await f.owner.close();
});
it('deadline and binding expiry are rechecked after mutation-lock wait',async()=>{
 for(const expiry of [false,true]){
  const f=fixture(),c=await active(f),started=deferred(),finish=deferred();
  f.setWrite(async command=>{started.resolve();await finish.promise;return Object.freeze({path:command.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});});
  const first=execute(f.owner,command('write_file',{deadline_at:'1970-01-01T00:10:00Z'}),c);await started.promise;
  const queued=execute(f.owner,command('write_file',{request_id:'queued',deadline_at:expiry?'1970-01-01T00:10:00Z':'1970-01-01T00:03:20Z'}),c);
  await tick();f.setNow(expiry?301n:201n);finish.resolve();await first;error(await queued,expiry?'binding_expired':'request_expired');assert.equal(f.counts().writes,1);await f.owner.close();
 }
});
it('cancellation removes a mutation-lock waiter without effects',async()=>{
 const f=fixture(),c=await active(f),started=deferred(),finish=deferred();
 f.setWrite(async command=>{started.resolve();await finish.promise;return Object.freeze({path:command.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});});
 const first=execute(f.owner,command('write_file'),c);await started.promise;const stop=new AbortController();
 const queued=execute(f.owner,command('write_file',{request_id:'queued'}),c,stop.signal);await tick();stop.abort();error(await queued,'request_cancelled');assert.equal(f.counts().writes,1);finish.resolve();await first;await f.owner.close();
});
it('uncertain effect failure blocks subsequent mutation attempts and never replays on reconnect',async()=>{
 const f=fixture(),c=await active(f);f.setWrite(async()=>{throw new Error('effect may have happened');});
 await assert.rejects(execute(f.owner,command('write_file'),c),/effect may have happened/);
 error(await execute(f.owner,command('write_file'),c),'computer_control',/uncertain/);assert.equal(f.counts().writes,1);
 await f.owner.retireConnection(c);const next=await f.owner.beginConnection(2n);await execute(f.owner,command(),next);await tick();error(await execute(f.owner,command('write_file'),next),'computer_control',/uncertain/);assert.equal(f.counts().writes,1);await f.owner.close();
});
it('successful mutation cache survives reconnect on the same project owner',async()=>{
 const f=fixture(),c=await active(f),first=await execute(f.owner,command('write_file'),c);
 await f.owner.retireConnection(c);const next=await f.owner.beginConnection(2n);await execute(f.owner,command(),next);
 assert.deepEqual(await execute(f.owner,command('write_file'),next),first);assert.equal(f.counts().writes,1);await f.owner.close();
});
it('retirement joins accepted operation settlement before any resource cleanup or reconnect',async()=>{
 const f=fixture(),c=await active(f),started=deferred(),finish=deferred();let observed:AbortSignal|undefined;
 f.setWrite(async(command,context)=>{observed=context.signal;started.resolve();await finish.promise;return Object.freeze({path:command.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});});
 const operation=execute(f.owner,command('write_file'),c);await started.promise;let retired=false;const retiring=f.owner.retireConnection(c).then(()=>{retired=true;});await tick();
 assert.equal(observed?.aborted,true);assert.equal(retired,false);assert.deepEqual(f.events,[]);await assert.rejects(f.owner.beginConnection(2n),/transition already owned/);
 finish.resolve();error(await operation,'request_cancelled');await retiring;assert.deepEqual(f.events,['computer','windows','terminals']);assert.equal(f.owner.snapshot().accepted,0);await f.owner.close();
});
it('session replacement installs the new identity before reporting previous cleanup failure',async()=>{
 const f=fixture();let creations=0;
 f.setSession(async()=>{const fail=++creations===1;return {stopComputer:async()=>{f.events.push('computer');if(fail)throw Error('cleanup failed');},closeTerminalWindows:async()=>{f.events.push('windows');},closeTerminals:async()=>{f.events.push('terminals');},computer:null,terminal:null,terminalWindow:null};});
 const c=await active(f);error(await execute(f.owner,command('project_session',{computer_session_id:OTHER,computer_session_generation:2}),c),'computer_control',/cleanup failed/);
 assert.deepEqual(f.events,['computer','windows','terminals']);assert.equal((await execute(f.owner,command('project_info',{computer_session_id:OTHER}),c)).type,'project_info_result');error(await execute(f.owner,command('project_info'),c),'computer_control');await assert.rejects(f.owner.close(),AggregateError);
});
it('device replacement keeps the new binding installed when previous cleanup fails',async()=>{
 const f=fixture();f.setSession(async()=>({stopComputer:async()=>{throw Error('old cleanup failure');},closeTerminalWindows:async()=>{},closeTerminals:async()=>{},computer:null,terminal:null,terminalWindow:null}));
 const c=await active(f);error(await execute(f.owner,command('device_session',{working_directory:'/synthetic/new'}),c),'computer_control',/cleanup failed/);
 assert.equal(f.owner.snapshot().projects,1);assert.equal(f.counts().opens,2);assert.deepEqual(f.events,['project']);
 // Upsert completed, but the failed command did not activate a new session.
 error(await execute(f.owner,command('project_info'),c),'computer_control',/not acknowledged/);await assert.rejects(f.owner.close(),AggregateError);
});
it('immutable captured configuration and resource ports cannot be retargeted after binding',async()=>{
 const f=fixture();f.config.openProject=async()=>{throw Error('must not run');};await f.bind();
 (f.backend as {writeFile:RemoteProjectBackend['writeFile']}).writeFile=async()=>{throw Error('mutated port');};
 const c=await f.owner.beginConnection(1n);await execute(f.owner,command(),c);assert.equal((await execute(f.owner,command('write_file'),c)).type,'write_file_result');assert.equal(f.counts().writes,1);await f.owner.close();
});
it('passive port and command validation reject getters and proxies without calling hooks',async()=>{
 let hooks=0;const f=fixture();assert.throws(()=>new RemoteProjectDispatcher({...f.config,get openProject():typeof f.config.openProject{hooks++;throw Error('getter');}}),TypeError);
 assert.throws(()=>new RemoteProjectDispatcher(new Proxy(f.config,{get(){hooks++;throw Error('proxy');}})),TypeError);
 const c=await active(f),input=command();assert.throws(()=>execute(f.owner,Object.freeze({...input,get thread_id(){hooks++;return 't';}}),c),TypeError);
 assert.throws(()=>execute(f.owner,new Proxy(input,{get(){hooks++;throw Error('proxy');}}),c),TypeError);assert.equal(hooks,0);await f.owner.close();
});
it('missing session or operation backend fails closed without fabricated success',async()=>{
 const f=fixture();(f.backend as {createSession:RemoteProjectBackend['createSession']}).createSession=null;await f.bind();const c=await f.owner.beginConnection(1n);error(await execute(f.owner,command(),c),'projectcapability');await f.owner.close();
 const g=fixture(),d=await active(g);error(await execute(g.owner,command('read_file',{path:'a',start_line:1,max_lines:10}),d),'projectcapability');error(await execute(g.owner,command('project_operation',{operation:{kind:'computer_list_windows'}}),d),'projectcapability');await g.owner.close();
});
it('four accepted direct calls bound lock retention and fifth is rejected without another pool',async()=>{
 const f=fixture(),c=await active(f),started=deferred(),finish=deferred();f.setWrite(async command=>{started.resolve();await finish.promise;return Object.freeze({path:command.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});});
 const first=execute(f.owner,command('write_file'),c);await started.promise;const others=[1,2,3].map(n=>execute(f.owner,command('write_file',{request_id:String(n)}),c));
 await assert.rejects(execute(f.owner,command('write_file',{request_id:'fifth'}),c),RemoteWorkerCapacityError);assert.equal(f.owner.snapshot().accepted,4);finish.resolve();await Promise.all([first,...others]);assert.equal(f.owner.snapshot().accepted,0);assert.equal(f.owner.snapshot().retainedCommandBytes,0);await f.owner.close();
});
it('replacement waits for pending session creation and cleans its resource before closing the old project',async()=>{
 const f=fixture();await f.bind();const c=await f.owner.beginConnection(1n),started=deferred(),finish=deferred();let calls=0;
 f.setSession(async()=>{if(++calls===1){started.resolve();await finish.promise;}return {stopComputer:async()=>{f.events.push('computer');},closeTerminalWindows:async()=>{f.events.push('windows');},closeTerminals:async()=>{f.events.push('terminals');},computer:null,terminal:null,terminalWindow:null};});
 const activation=execute(f.owner,command(),c);await started.promise;const replacement=execute(f.owner,command('device_session'),c);await tick();assert.deepEqual(f.events,[]);finish.resolve();error(await activation,'request_cancelled');assert.equal((await replacement).type,'project_session_result');assert.deepEqual(f.events,['computer','windows','terminals','project']);await f.owner.close();
});
it('session activation expiry while waiting for initialization closes all newly created resources',async()=>{
 const f=fixture(),started=deferred(),finish=deferred();f.setSession(async()=>{started.resolve();await finish.promise;return {stopComputer:async()=>{f.events.push('computer');},closeTerminalWindows:async()=>{f.events.push('windows');},closeTerminals:async()=>{f.events.push('terminals');},computer:null,terminal:null,terminalWindow:null};});
 await f.bind();const c=await f.owner.beginConnection(1n),activation=execute(f.owner,command(),c);await started.promise;f.setNow(201n);finish.resolve();error(await activation,'request_expired');assert.deepEqual(f.events,['computer','windows','terminals']);await f.owner.close();
});
it('cleanup failure is terminal for reconnect and repeated owner close does not fake success or retry',async()=>{
 const f=fixture();f.setSession(async()=>({stopComputer:async()=>{f.events.push('computer');throw Error('cleanup failed');},closeTerminalWindows:async()=>{f.events.push('windows');},closeTerminals:async()=>{f.events.push('terminals');},computer:null,terminal:null,terminalWindow:null}));
 await active(f);const first=f.owner.close();await assert.rejects(first,AggregateError);assert.equal(f.owner.close(),first);await assert.rejects(f.owner.close(),AggregateError);assert.deepEqual(f.events,['computer','windows','terminals','project']);await assert.rejects(f.owner.beginConnection(2n),/closed or cleanup failed/);
});
it('one project mutation lock does not block another project and leaf context retains the exact binding',async()=>{
 const f=fixture();await f.bind();await f.owner.upsert({threadId:'other',root:'/synthetic/other',expiresAt:date(300n)});
 const c=await f.owner.beginConnection(1n);await execute(f.owner,command(),c);await execute(f.owner,command('project_session',{thread_id:'other'}),c);
 const started=deferred(),finish=deferred();const roots:string[]=[];
 f.setWrite(async(command,context)=>{roots.push(context.binding.root);if(command.thread_id==='t'){started.resolve();await finish.promise;}return Object.freeze({path:command.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});});
 const first=execute(f.owner,command('write_file'),c);await started.promise;
 const second=await execute(f.owner,command('write_file',{thread_id:'other'}),c);assert.equal(second.type,'write_file_result');assert.deepEqual(roots,['/synthetic/project','/synthetic/other']);finish.resolve();await first;await f.owner.close();
});
it('project replacement joins the original session operation before releasing its root',async()=>{
 const f=fixture(),c=await active(f),started=deferred(),finish=deferred();let context:RemoteOperationContext|undefined;
 f.setWrite(async(command,value)=>{context=value;started.resolve();await finish.promise;return Object.freeze({path:command.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});});
 const first=execute(f.owner,command('write_file'),c);await started.promise;let replaced=false;
 const replacement=execute(f.owner,command('device_session',{working_directory:'/synthetic/replacement'}),c).then(v=>{replaced=true;return v;});await tick();
 assert.equal(replaced,false);assert.equal(context!.binding.root,'/synthetic/project');assert.equal(context!.signal.aborted,true);assert.deepEqual(f.events,[]);
 finish.resolve();error(await first,'request_cancelled');assert.equal((await replacement).type,'project_session_result');assert.deepEqual(f.events,['computer','windows','terminals','project']);assert.equal(f.counts().writes,1);await f.owner.close();
});
it('project and command text limits reject excess before acquiring resources',async()=>{
 const f=fixture();for(let i=0;i<16;i++)await f.owner.upsert({threadId:String(i),root:'/synthetic/'+i,expiresAt:date(300n)});
 await assert.rejects(f.owner.upsert({threadId:'overflow',root:'/synthetic/overflow',expiresAt:date(300n)}),RemoteWorkerCapacityError);assert.equal(f.counts().opens,16);
 const c=await f.owner.beginConnection(1n),large=Object.freeze({...command('write_file'),content:'x'.repeat(1500000)});
 assert.throws(()=>execute(f.owner,large,c),RangeError);assert.equal(f.owner.snapshot().accepted,0);await f.owner.close();
});
it('nonmutating malformed backend result is rejected before it can leave the owner',async()=>{
 const f=fixture();(f.backend as {readFile:RemoteProjectBackend['readFile']}).readFile=async()=>Object.freeze({path:'a',content:'x',sha256:'hash',start_line:0n,end_line:1n,total_lines:1n,truncated:false,redacted:false});
 const c=await active(f);await assert.rejects(execute(f.owner,command('read_file',{path:'a',start_line:1,max_lines:10}),c),/start_line/);await f.owner.close();
});
it('session cleanup ports are captured once and all phases run despite later caller mutation',async()=>{
 const f=fixture();const raw:RemoteSessionBackend={stopComputer:async()=>{f.events.push('computer');},closeTerminalWindows:async()=>{f.events.push('windows');},closeTerminals:async()=>{f.events.push('terminals');},computer:null,terminal:null,terminalWindow:null};f.setSession(async()=>raw);
 const c=await active(f);(raw as {stopComputer:()=>Promise<void>}).stopComputer=async()=>{throw Error('retargeted');};await f.owner.retireConnection(c);assert.deepEqual(f.events,['computer','windows','terminals']);await f.owner.close();
});
it('project replacement also joins a detached session still owned by an overlapping activation',async()=>{
 const f=fixture(),c=await active(f),started=deferred(),finish=deferred();
 f.setWrite(async command=>{started.resolve();await finish.promise;return Object.freeze({path:command.path,sha256:'a'.repeat(64),bytes_written:1n,created:true});});
 const operation=execute(f.owner,command('write_file'),c);await started.promise;
 const activation=execute(f.owner,command('project_session',{computer_session_id:OTHER,computer_session_generation:2}),c);await tick();
 const replacement=execute(f.owner,command('device_session',{working_directory:'/synthetic/new'}),c);await tick();assert.equal(f.events.includes('project'),false);
 finish.resolve();error(await operation,'request_cancelled');await activation;assert.equal((await replacement).type,'project_session_result');assert.equal(f.events.filter(x=>x==='project').length,1);assert.equal(f.events.filter(x=>x==='computer').length,2);await f.owner.close();
});
it('malformed project operations with failed release retain a terminal quarantine receipt',async()=>{
 const f=fixture();let releases=0;
 const raw={...f.backend,close:async()=>{releases++;throw Error('failed malformed release');},writeFile:42} as unknown as RemoteProjectBackend;
 const owner=new RemoteProjectDispatcher({...f.config,openProject:async()=>raw});
 await assert.rejects(owner.upsert({threadId:'t',root:'/synthetic',expiresAt:date(300n)}),AggregateError);assert.equal(owner.snapshot().quarantinedResources,1);
 await assert.rejects(owner.beginConnection(1n),/cleanup failed/);await assert.rejects(owner.upsert({threadId:'other',root:'/synthetic',expiresAt:date(300n)}),/cleanup failed/);
 const closing=owner.close();await assert.rejects(closing,AggregateError);await assert.rejects(owner.close(),AggregateError);assert.equal(releases,1);
});
it('malformed project release paths are never accessed and cannot become a successful close',async()=>{
 const f=fixture();let hooks=0;const raw={...f.backend,get close(){hooks++;throw Error('accessor');}} as unknown as RemoteProjectBackend;
 const owner=new RemoteProjectDispatcher({...f.config,openProject:async()=>raw});
 await assert.rejects(owner.upsert({threadId:'t',root:'/synthetic',expiresAt:date(300n)}),AggregateError);assert.equal(hooks,0);assert.equal(owner.snapshot().quarantinedResources,1);await assert.rejects(owner.close(),AggregateError);
});
it('malformed session release attempts remaining valid phases and retains failure without re-creation',async()=>{
 const f=fixture();let hooks=0;f.setSession(async()=>({get stopComputer(){hooks++;throw Error('getter');},closeTerminalWindows:async()=>{f.events.push('windows');},closeTerminals:async()=>{f.events.push('terminals');},computer:null,terminal:null,terminalWindow:null}) as unknown as RemoteSessionBackend);
 await f.bind();const c=await f.owner.beginConnection(1n);error(await execute(f.owner,command(),c),'computer_control',/creation failed/);assert.equal(hooks,0);assert.deepEqual(f.events,['windows','terminals']);assert.equal(f.owner.snapshot().quarantinedResources,1);
 error(await execute(f.owner,command('project_session',{computer_session_generation:2}),c),'computer_control',/cleanup failed/);assert.equal(f.counts().creates,1);await assert.rejects(f.owner.beginConnection(2n),/cleanup failed/);await assert.rejects(f.owner.close(),AggregateError);assert.deepEqual(f.events,['windows','terminals','project']);
});
it('malformed session operation ports retain custody until cleanup settles and successful cleanup releases quarantine',async()=>{
 const f=fixture(),started=deferred(),finish=deferred();f.setSession(async()=>({stopComputer:async()=>{started.resolve();await finish.promise;f.events.push('computer');},closeTerminalWindows:async()=>{f.events.push('windows');},closeTerminals:async()=>{f.events.push('terminals');},computer:42,terminal:null,terminalWindow:null}) as unknown as RemoteSessionBackend);
 await f.bind();const c=await f.owner.beginConnection(1n),activation=execute(f.owner,command(),c);await started.promise;assert.equal(f.owner.snapshot().quarantinedResources,1);
 await assert.rejects(f.owner.beginConnection(2n),/cleanup failed/);finish.resolve();error(await activation,'computer_control',/creation failed/);assert.equal(f.owner.snapshot().quarantinedResources,0);assert.deepEqual(f.events,['computer','windows','terminals']);await f.owner.close();
});
it('volatile cache non-retention permits a newly submitted duplicate, never an automatic replay',async()=>{
 const f=fixture(),c=await active(f);f.setWrite(async()=>Object.freeze({path:'p'.repeat(75000),sha256:'a'.repeat(64),bytes_written:1n,created:true}));
 assert.equal((await execute(f.owner,command('write_file'),c)).type,'write_file_result');await tick();assert.equal(f.counts().writes,1);
 assert.equal((await execute(f.owner,command('write_file'),c)).type,'write_file_result');assert.equal(f.counts().writes,2);await f.owner.close();
});
it('volatile cache byte eviction permits a newly submitted old request without claiming exactly-once execution',async()=>{
 const f=fixture(),c=await active(f);f.setWrite(async()=>Object.freeze({path:'p'.repeat(40000),sha256:'a'.repeat(64),bytes_written:1n,created:true}));
 await execute(f.owner,command('write_file',{request_id:'a'}),c);await execute(f.owner,command('write_file',{request_id:'b'}),c);assert.equal(f.counts().writes,2);await tick();assert.equal(f.counts().writes,2);
 await execute(f.owner,command('write_file',{request_id:'a'}),c);assert.equal(f.counts().writes,3);await f.owner.close();
});
it('late factory completion after another transferred resource fails is cleaned without installing a session',async()=>{
 const f=fixture();await f.bind();await f.owner.upsert({threadId:'other',root:'/synthetic/other',expiresAt:date(300n)});const c=await f.owner.beginConnection(1n),started=deferred(),finish=deferred();let calls=0;
 f.setSession(async()=>{if(++calls===1){started.resolve();await finish.promise;return {stopComputer:async()=>{f.events.push('late-computer');},closeTerminalWindows:async()=>{f.events.push('late-windows');},closeTerminals:async()=>{f.events.push('late-terminals');},computer:null,terminal:null,terminalWindow:null};}return {stopComputer:async()=>{throw Error('failed release');},closeTerminalWindows:async()=>{},closeTerminals:async()=>{},computer:42,terminal:null,terminalWindow:null} as unknown as RemoteSessionBackend;});
 const first=execute(f.owner,command(),c);await started.promise;error(await execute(f.owner,command('project_session',{thread_id:'other'}),c),'computer_control');finish.resolve();error(await first,'computer_control',/cleanup failed/);
 assert.deepEqual(f.events,['late-computer','late-windows','late-terminals']);error(await execute(f.owner,command('project_info'),c),'computer_control',/not acknowledged/);await assert.rejects(f.owner.close(),AggregateError);
});
it('retirement maps a late nonmutating read completion to cancellation after actual settlement',async()=>{
 const f=fixture(),started=deferred(),finish=deferred();(f.backend as {readFile:RemoteProjectBackend['readFile']}).readFile=async()=>{started.resolve();await finish.promise;return Object.freeze({path:'a',content:'x',sha256:'a'.repeat(64),start_line:1n,end_line:1n,total_lines:1n,truncated:false,redacted:false});};
 const c=await active(f),read=execute(f.owner,command('read_file',{path:'a',start_line:1,max_lines:10}),c);await started.promise;let retired=false;const closing=f.owner.retireConnection(c).then(()=>{retired=true;});await tick();assert.equal(retired,false);assert.deepEqual(f.events,[]);
 finish.resolve();error(await read,'request_cancelled');await closing;assert.deepEqual(f.events,['computer','windows','terminals']);await f.owner.close();
});
it('ordinary read backend errors use the redacting file-error result without becoming session failures',async()=>{
 const f=fixture();(f.backend as {readFile:RemoteProjectBackend['readFile']}).readFile=async()=>{throw Error('synthetic read failure');};
 const c=await active(f);error(await execute(f.owner,command('read_file',{path:'a',start_line:1,max_lines:10}),c),'projectfile',/synthetic read failure/);assert.equal(f.owner.snapshot().faulted,false);assert.equal((await execute(f.owner,command('project_info'),c)).type,'project_info_result');await f.owner.close();
});
it('synchronous project factory return is released or quarantined without assimilating a hostile then getter',async()=>{
 const f=fixture();let hooks=0,releases=0;
 const raw={...f.backend,get then(){hooks++;throw Error('then getter');},close:async()=>{releases++;throw Error('release failed');}};
 const owner=new RemoteProjectDispatcher({...f.config,openProject:(()=>raw) as unknown as typeof f.config.openProject});
 await assert.rejects(owner.upsert({threadId:'t',root:'/synthetic',expiresAt:date(300n)}),AggregateError);assert.equal(hooks,0);assert.equal(releases,1);assert.equal(owner.snapshot().quarantinedResources,1);await assert.rejects(owner.beginConnection(1n),/cleanup failed/);await assert.rejects(owner.close(),AggregateError);assert.equal(releases,1);
});
it('synchronous session factory return attempts each release once without reading then or allowing repeated allocation',async()=>{
 const f=fixture();let hooks=0;const raw={stopComputer:async()=>{f.events.push('computer');throw Error('release failed');},closeTerminalWindows:async()=>{f.events.push('windows');},closeTerminals:async()=>{f.events.push('terminals');},computer:null,terminal:null,terminalWindow:null,get then(){hooks++;throw Error('then getter');}};
 (f.backend as {createSession:RemoteProjectBackend['createSession']}).createSession=(()=>raw) as unknown as RemoteProjectBackend['createSession'];
 await f.bind();const c=await f.owner.beginConnection(1n);error(await execute(f.owner,command(),c),'computer_control',/creation failed/);assert.equal(hooks,0);assert.deepEqual(f.events,['computer','windows','terminals']);assert.equal(f.owner.snapshot().quarantinedResources,1);
 error(await execute(f.owner,command(),c),'computer_control',/cleanup failed/);await assert.rejects(f.owner.close(),AggregateError);assert.deepEqual(f.events,['computer','windows','terminals','project']);
});
it('synchronous malformed project return with successful release leaves no retained failed resource',async()=>{
 const f=fixture();let releases=0;const raw={...f.backend,close:async()=>{releases++;}};
 const owner=new RemoteProjectDispatcher({...f.config,openProject:(()=>raw) as unknown as typeof f.config.openProject});
 await assert.rejects(owner.upsert({threadId:'t',root:'/synthetic',expiresAt:date(300n)}),/native Promise/);assert.equal(releases,1);assert.equal(owner.snapshot().quarantinedResources,0);await owner.beginConnection(1n);await owner.close();
});
