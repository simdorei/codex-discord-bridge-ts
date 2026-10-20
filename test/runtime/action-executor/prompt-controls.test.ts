import test from 'node:test';
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {promptFixture,callPromptFixture} from '../../helpers/server-prompt-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {createMutationCustodyFence} from '../../../src/runtime/mutation-custody-fence.ts';
import {AppServerTurnBackend} from '../../../src/runtime/app-server-turn-backend.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {ActionTargetServices} from '../../../src/runtime/action-executor/action-target.ts';
import {ActionThreadSelection} from '../../../src/runtime/action-executor/thread-selection.ts';
import {PromptControlActions} from '../../../src/runtime/action-executor/prompt-controls.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {userOriginMarker} from '../../../src/store/mirror-origin.ts';
function actions(path:string,server:PortableResidentLifecycle,selected:PortableResidentLifecycle|null=server,locks=new TargetLocks()){
 const bridge=new BridgeState(join(dirname(path),'controls-bridge.json'));bridge.setSelectedThreadId('t');const selection=new ActionThreadSelection('unused-state',path,bridge),queue=new QueueStartCoordinator(path,new AppServerTurnBackend(server,()=> 'fixture'));
 const target=new ActionTargetServices(path,bridge,queue,{preparePrompt:async()=>assert.fail('not prompt execution'),busyResult:async()=>assert.fail('not busy choice')});
 return {action:new PromptControlActions(path,selection,target,new ControlTurnVerifier(path,selected,bridge,locks),selected,()=>10),locks};
}
async function fixture(run:(path:string,server:PortableResidentLifecycle,seen:()=>Promise<any[]>)=>Promise<void>,reject=false){await storeFixture(async path=>{
 const db=await openInitialized(path);db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime');INSERT INTO codex_app_server_runtime VALUES(1,'runtime');INSERT INTO mirror_threads VALUES('t','p','title',10,1,1)");db.close();const code=`import readline from 'node:readline';const seen=[];const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l),reply=result=>emit({id:m.id,result});if(m.method==='initialize')reply({});else if(m.method==='initialized'){}else if(m.method==='seed'){emit({method:'turn/started',params:{threadId:'t',turnId:'v'}});reply({});}else if(m.method==='seen')reply(seen);else{seen.push({method:m.method,params:m.params});if(${reject})emit({id:m.id,error:{code:-8,message:'fixture control rejected'}});else reply({});}});`;
 const render=(e:unknown)=>e instanceof Error?e.message:'opaque';const owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'controls',title:'fixture',version:'1'}},render,{persistDeadWork(){},oldChildExited(){}},undefined,{renderError:render,fence:createMutationCustodyFence(path,'runtime',render)});
 const call=async(method:string)=>{const a=owner.admitResponse(owner.generation());try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}};
 try{await call('seed');await run(path,owner,async()=>await call('seen') as any[]);}finally{await owner.dispose();}
});}
test('ordinary steer uses exact cached turn and real mutation fence after recording original marker',async()=>fixture(async(path,server,seen)=>{
 const f=actions(path,server),result=await f.action.steer(1n,'  방향 😀  ');assert.equal(result.text,'Steering request submitted to t.');const calls=await seen();assert.equal(calls.length,1);assert.equal(calls[0].method,'turn/steer');assert.equal(calls[0].params.threadId,'t');assert.equal(calls[0].params.expectedTurnId,'v');
 const db=await openInitialized(path);try{assert.ok(db.prepare('SELECT 1 FROM codex_session_mirror_events WHERE event_digest=?').get(userOriginMarker('t','v','  방향 😀  ')));}finally{db.close();}assert.equal(f.locks.activeTargetCount,0);
}));
test('observed completed turn blocks steer and no origin or RPC is produced',async()=>fixture(async(path,server,seen)=>{
 const f=actions(path,server),db=await openInitialized(path);try{db.exec("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES('t','v',1,'{}')");}finally{db.close();}await assert.rejects(f.action.steer(1n,'do not send'),/turn completed/);assert.deepEqual(await seen(),[]);assert.equal(f.locks.activeTargetCount,0);
}));
test('mapping change during lock wait prevents steering a substituted target',async()=>fixture(async(path,server,seen)=>{
 let entered!:()=>void;const waiting=new Promise<void>(r=>{entered=r;});let calls=0;class TrackedLocks extends TargetLocks {override acquire(target:string,signal?:AbortSignal){const p=super.acquire(target,signal);if(++calls===2)entered();return p;}}const f=actions(path,server,server,new TrackedLocks()),lease=await f.locks.acquire('t'),work=f.action.steer(1n,'no'),rejected=assert.rejects(work,/control target changed/);await waiting;const db=await openInitialized(path);try{db.exec("UPDATE mirror_threads SET codex_thread_id='other'");}finally{db.close();}lease.release();await rejected;assert.deepEqual(await seen(),[]);assert.equal(f.locks.activeTargetCount,0);
}));
test('origin journal failure prevents outbound bytes and releases control lock',async()=>fixture(async(path,server,seen)=>{
 const db=await openInitialized(path);try{db.exec("CREATE TRIGGER origin_failure BEFORE INSERT ON codex_session_mirror_events BEGIN SELECT RAISE(ABORT,'origin fixture failure'); END");}finally{db.close();}const f=actions(path,server);await assert.rejects(f.action.steer(1n,'no'),/origin fixture failure/);assert.deepEqual(await seen(),[]);assert.equal(f.locks.activeTargetCount,0);
}));
test('remote rejection retains original marker and does not retry or fork',async()=>fixture(async(path,server,seen)=>{
 const f=actions(path,server);await assert.rejects(f.action.steer(1n,'original'),/fixture control rejected/);assert.equal((await seen()).length,1);const db=await openInitialized(path);try{assert.ok(db.prepare('SELECT 1 FROM codex_session_mirror_events WHERE event_digest=?').get(userOriginMarker('t','v','original')));}finally{db.close();}assert.equal(f.locks.activeTargetCount,0);
},true));
test('cancelled waiter cannot release another target owner or send RPC',async()=>fixture(async(path,server,seen)=>{
 const f=actions(path,server),lease=await f.locks.acquire('t'),a=new AbortController(),reason=new Error('shutdown'),work=f.action.steer(1n,'no',a.signal),rejected=assert.rejects(work,e=>e===reason);a.abort(reason);await rejected;assert.equal(f.locks.activeTargetCount,1);lease.release();assert.deepEqual(await seen(),[]);
}));
test('approval prepares real pending UI without submitting responses or changing its occurrence',async()=>promptFixture(async(path,server,request)=>{
 const f=actions(path,server),result=await f.action.approval(1n,2n);assert.equal(result.text,'Existing Codex approval/input requests: 1\nthread: t');assert.equal(result.ui?.kind,'ServerPrompts');assert.ok(result.ui?.kind==='ServerPrompts');assert.equal(result.ui.prompts[0]?.unavailable,false);assert.deepEqual(result.ui.prompts[0]?.request.occurrence.asBytes(),request.occurrence.asBytes());assert.deepEqual(await callPromptFixture(server,'answers'),[]);
 const stranger=await f.action.approval(1n,9n);assert.ok(stranger.ui?.kind==='ServerPrompts');assert.equal(stranger.ui.prompts[0]?.unavailable,true);assert.deepEqual(stranger.ui.prompts[0]?.prompt.components,[]);
}));
test('empty approval snapshot and missing resident are explicit without fabricated prompts',async()=>fixture(async(path,server,seen)=>{
 const f=actions(path,server);assert.deepEqual(await f.action.approval(1n,2n),{text:'No pending Codex approval or input request for t.',waitsForFinal:false,ui:null});const missing=actions(path,server,null);await assert.rejects(missing.action.approval(1n,2n),/app-server is unavailable/);await assert.rejects(missing.action.steer(1n,'no'),/app-server is unavailable/);assert.deepEqual(await seen(),[]);
}));
