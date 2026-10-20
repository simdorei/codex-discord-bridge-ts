import {it} from 'node:test';
import assert from 'node:assert/strict';
import {RemoteProjectDispatcher} from '../../src/remote-agent/project-dispatcher.ts';
import type {RemoteProjectBackend,RemoteSessionBackend} from '../../src/remote-agent/dispatcher-ports.ts';
import {RemoteOperationFailure} from '../../src/remote-agent/operation-failure.ts';
import {settledRemoteOperationFailure,type RemoteSettledOperationFailure} from '../../src/remote-agent/operation-error-result.ts';
import {parseGatewayCommand,type GatewayCommand} from '../../src/remote-agent/gateway-command.ts';
import type {BridgeResult} from '../../src/remote-agent/bridge-inbound.ts';
const date=(seconds:bigint)=>Object.freeze({seconds,nanosecond:0n});
const command=(operation:object|null=null,extra:object={}):GatewayCommand=>parseGatewayCommand(JSON.stringify({type:operation===null?'project_session':'project_operation',request_id:'0009007199254740993',thread_id:'t',computer_session_id:'abcdefghijklmnop',deadline_at:'1970-01-01T00:03:20Z',...(operation===null?{computer_session_generation:1}:{operation}),...extra}),1048576,0);
const checkpoint=()=>new RemoteOperationFailure({family:'checkpoint',failure:{kind:'Invalid',value:'cp_fixture'}});
const terminal=()=>new RemoteOperationFailure({family:'terminal',failure:{kind:'Cancelled'}});
const expectError=(result:BridgeResult,code:string)=>{assert.equal(result.type,'operation_error');if(result.type==='operation_error')assert.equal(result.error_code,code);return result;};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
function fixture(){
 let now=100n,calls=0;
 let write:NonNullable<RemoteProjectBackend['writeFile']>=async request=>settledRemoteOperationFailure(request,checkpoint());
 let core:NonNullable<RemoteProjectBackend['core']>=async request=>settledRemoteOperationFailure(request,checkpoint());
 let run:NonNullable<RemoteSessionBackend['terminal']>=async request=>settledRemoteOperationFailure(request,terminal());
 const backend:RemoteProjectBackend={close:async()=>{},listFiles:null,readFile:null,writeFile:async(...args)=>{calls++;return write(...args);},core:async(...args)=>{calls++;return core(...args);},createSession:async()=>({stopComputer:async()=>{},closeTerminalWindows:async()=>{},closeTerminals:async()=>{},computer:null,terminal:async(...args)=>{calls++;return run(...args);},terminalWindow:async(...args)=>{calls++;return run(...args);}})};
 const owner=new RemoteProjectDispatcher({openProject:async()=>backend,nowUtc:()=>date(now),nowMonotonic:()=>0n});
 return {owner,setWrite:(fn:typeof write)=>{write=fn;},setCore:(fn:typeof core)=>{core=fn;},setTerminal:(fn:typeof run)=>{run=fn;},setNow:(n:bigint)=>{now=n;},calls:()=>calls,async activate(){await owner.upsert({threadId:'t',root:'/synthetic/only',expiresAt:date(300n)});const connection=await owner.beginConnection(1n);assert.equal((await owner.execute(command(),connection,new AbortController().signal)).type,'project_session_result');return connection;}};
}
const writeCommand=(extra:object={})=>parseGatewayCommand(JSON.stringify({type:'write_file',request_id:'0009007199254740993',thread_id:'t',computer_session_id:'abcdefghijklmnop',deadline_at:'1970-01-01T00:03:20Z',path:'fixture',content:'synthetic',...extra}),1048576,0);

it('write, core and both terminal ports map explicit returned failures and preserve owner request identity',async()=>{
 const f=fixture(),connection=await f.activate();
 try{
  const cases:readonly [GatewayCommand,string][]=[[writeCommand(),'projectcheckpoint'],[command({kind:'checkpoint_restore',checkpoint_id:'cp_0000000000000000'}),'projectcheckpoint'],[command({kind:'terminal_exec',command:'synthetic only'}),'terminal_execution'],[command({kind:'terminal_window_list'}),'terminal_execution']];
  for(const [request,code] of cases){const result=expectError(await f.owner.execute(request,connection,new AbortController().signal),code);assert.equal(result.request_id,'0009007199254740993');assert.ok(Object.isFrozen(result));}
  assert.equal(f.calls(),4);
 }finally{await f.owner.close();}
});
it('composite project status accepts source Git, Code and Command error families without rerouting them',async()=>{
 const f=fixture(),connection=await f.activate();
 try{for(const [failure,code] of [[new RemoteOperationFailure({family:'git',failure:{kind:'Cancelled'}}),'projectgit'],[new RemoteOperationFailure({family:'code',failure:{kind:'Cancelled'}}),'request_cancelled'],[new RemoteOperationFailure({family:'command',failure:{kind:'Rejected',commandId:'test',reason:'rejected'}}),'projectcommand']] as const){f.setCore(async request=>settledRemoteOperationFailure(request,failure));expectError(await f.owner.execute(command({kind:'project_status'}),connection,new AbortController().signal),code);}}finally{await f.owner.close();}
});
it('settled mutation errors are skipped by existing cache and never automatically replayed',async()=>{
 const f=fixture(),connection=await f.activate(),request=writeCommand();
 try{expectError(await f.owner.execute(request,connection,new AbortController().signal),'projectcheckpoint');await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.calls(),1);expectError(await f.owner.execute(request,connection,new AbortController().signal),'projectcheckpoint');assert.equal(f.calls(),2);expectError(await f.owner.execute(command({kind:'file_create',path:'other',content:'synthetic'}),connection,new AbortController().signal),'projectcheckpoint');assert.equal(f.calls(),3);}finally{await f.owner.close();}
});
it('throwing a typed diagnostic or authentic receipt retains mutation uncertainty across reconnect',async()=>{
 for(const mode of ['diagnostic','receipt'] as const){const f=fixture();f.setWrite(async request=>{throw mode==='diagnostic'?checkpoint():settledRemoteOperationFailure(request,checkpoint());});const connection=await f.activate();try{await assert.rejects(f.owner.execute(writeCommand(),connection,new AbortController().signal));expectError(await f.owner.execute(writeCommand(),connection,new AbortController().signal),'computer_control');assert.equal(f.calls(),1);await f.owner.retireConnection(connection);const next=await f.owner.beginConnection(2n);await f.owner.execute(command(),next,new AbortController().signal);expectError(await f.owner.execute(writeCommand(),next,new AbortController().signal),'computer_control');assert.equal(f.calls(),1);}finally{await f.owner.close();}}
});
it('copied, proxied, forged and foreign-request receipts cannot hide uncertainty or execute dispatcher hooks',async()=>{
 let hooks=0,thenReads=0;
 // The two native async return layers each check thenability before the owner
 // receives the value. All subsequent proxy access by the dispatcher is forbidden.
 for(const mode of ['copy','proxy','forge','crossed'] as const){const f=fixture();f.setWrite(async request=>{const foreign=writeCommand();assert.equal(foreign.type,'write_file');const receipt=settledRemoteOperationFailure(mode==='crossed'&&foreign.type==='write_file'?foreign:request,checkpoint());return (mode==='copy'?Object.freeze({...receipt}):mode==='proxy'?new Proxy(receipt,{get(_target,key){if(key==='then'){thenReads++;return undefined;}hooks++;throw 0;},getOwnPropertyDescriptor(){hooks++;throw 0;},getPrototypeOf(){hooks++;throw 0;}}):mode==='forge'?Object.freeze(Object.create(null)):receipt) as RemoteSettledOperationFailure;});const connection=await f.activate();try{await assert.rejects(f.owner.execute(writeCommand(),connection,new AbortController().signal));expectError(await f.owner.execute(writeCommand(),connection,new AbortController().signal),'computer_control');assert.equal(f.calls(),1);}finally{await f.owner.close();}}
 assert.equal(hooks,0);assert.equal(thenReads,2);
});
it('reusing a consumed returned receipt is uncertain even for the same original command object',async()=>{
 const f=fixture();let saved:RemoteSettledOperationFailure|undefined;f.setWrite(async request=>saved??=settledRemoteOperationFailure(request,checkpoint()));const connection=await f.activate(),request=writeCommand();try{expectError(await f.owner.execute(request,connection,new AbortController().signal),'projectcheckpoint');await assert.rejects(f.owner.execute(request,connection,new AbortController().signal),/already consumed/);expectError(await f.owner.execute(request,connection,new AbortController().signal),'computer_control');assert.equal(f.calls(),2);}finally{await f.owner.close();}
});
it('receipt family mismatch thrown in a mutation leaf remains an uncertain exception',async()=>{
 const f=fixture();f.setWrite(async request=>settledRemoteOperationFailure(request,terminal()));const connection=await f.activate();try{await assert.rejects(f.owner.execute(writeCommand(),connection,new AbortController().signal),/family differs/);expectError(await f.owner.execute(writeCommand(),connection,new AbortController().signal),'computer_control');assert.equal(f.calls(),1);}finally{await f.owner.close();}
});
it('cancellation joins an accepted leaf and preserves the uncertain barrier after aborted cache admission',async()=>{
 const f=fixture(),started=deferred(),finish=deferred();f.setWrite(async request=>{started.resolve();await finish.promise;return settledRemoteOperationFailure(request,checkpoint());});const connection=await f.activate(),stop=new AbortController();let settled=false;
 const pending=f.owner.execute(writeCommand(),connection,stop.signal).finally(()=>{settled=true;});await started.promise;stop.abort();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false);finish.resolve();try{expectError(await pending,'request_cancelled');expectError(await f.owner.execute(writeCommand(),connection,new AbortController().signal),'computer_control');assert.equal(f.calls(),1);}finally{await f.owner.close();}
});
it('owner cancellation and deadline checks still precede leaf error translation',async()=>{
 const f=fixture(),connection=await f.activate();try{f.setNow(201n);const stopped=new AbortController();stopped.abort();expectError(await f.owner.execute(writeCommand(),connection,stopped.signal),'request_cancelled');expectError(await f.owner.execute(writeCommand(),connection,new AbortController().signal),'request_expired');assert.equal(f.calls(),0);}finally{await f.owner.close();}
});
it('awaited post-leaf mapper rejection remains inside mutation uncertainty handling',async()=>{
 const f=fixture(),connection=await f.activate();try{const request=writeCommand({request_id:'🧪'.repeat(1500)});await assert.rejects(f.owner.execute(request,connection,new AbortController().signal),/identity exceeds byte limit/);expectError(await f.owner.execute(writeCommand(),connection,new AbortController().signal),'computer_control');assert.equal(f.calls(),1);}finally{await f.owner.close();}
});
