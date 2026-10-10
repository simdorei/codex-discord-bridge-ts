import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {AppServerTurnBackend} from '../../../src/runtime/app-server-turn-backend.ts';
import {createMutationCustodyFence} from '../../../src/runtime/mutation-custody-fence.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {PromptIntakeProcessor} from '../../../src/runtime/prompt-intake/processor.ts';
import {ActionTargetServices} from '../../../src/runtime/action-executor/action-target.ts';
import {NewThreadExecutor,type NewMirrorLink} from '../../../src/runtime/action-executor/new-executor.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
const context=()=>({channelId:99n,userId:20n,discordMessageId:30n,autoQueueWhenBusy:true});
const code=`import readline from 'node:readline';let mode='',seen=[];const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),reply=result=>emit({id:m.id,result});if(m.method==='initialized')return;if(m.method==='initialize'){reply({});return;}if(m.method==='fixture/mode'){mode=m.params.mode;reply({});return;}if(m.method==='fixture/seen'){reply(seen);return;}seen.push({method:m.method,params:m.params});if(m.method==='thread/start'){if(mode==='hang')return;if(mode==='missing'){reply({});return;}reply({thread:{id:'new-thread'}});return;}if(m.method==='thread/resume'){reply({thread:{id:m.params.threadId}});return;}if(m.method==='thread/read'){reply({thread:{id:m.params.threadId,turns:[]}});return;}if(m.method==='turn/start'){reply({turn:{id:'new-turn'}});return;}emit({id:m.id,error:{code:-9,message:'unexpected fixture request'}});});`;
async function fixture(t:TestContext,run:(f:{path:string;executor:NewThreadExecutor;bridge:BridgeState;owner:PortableResidentLifecycle;make(mirror:NewMirrorLink|null):NewThreadExecutor;mode(value:string):Promise<void>;seen():Promise<any[]>})=>Promise<void>){await storeFixture(async path=>{
 const db=await openInitialized(path);db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime');INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");db.close();const render=(e:unknown)=>e instanceof Error?e.message:'opaque';
 const owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'new-test',title:'fixture',version:'1'}},render,{persistDeadWork(){},oldChildExited(){}},t.signal,{renderError:render,fence:createMutationCustodyFence(path,'runtime',render)});
 const backend=new AppServerTurnBackend(owner,render,{resumeTimeoutMs:1000,historyTimeoutMs:1000}),queue=new QueueStartCoordinator(path,backend,{clock:()=>10}),bridge=new BridgeState(join(dirname(path),'bridge.json'));
 const targets=new ActionTargetServices(path,bridge,queue,{preparePrompt:async raw=>raw+' enriched',busyResult:async()=>assert.fail('durably admitted input must queue')}),intake=new PromptIntakeProcessor(path,queue,targets,{clock:()=>10,ticks:()=>({wait:()=>new Promise<void>(()=>{}),close(){}})}),executor=new NewThreadExecutor(path,'unused-state',queue,intake,bridge,owner,backend,null,()=>{},()=>10);
 const call=async(method:string,params:unknown)=>{const a=owner.admitResponse(owner.generation());try{return await a.client.requestAdmitted(a.permit,method,params,1000,undefined,t.signal);}finally{a.release();}};
 try{await run({path,executor,bridge,owner,make:mirror=>new NewThreadExecutor(path,'unused-state',queue,intake,bridge,owner,backend,mirror,()=>{},()=>10),mode:async mode=>{await call('fixture/mode',{mode});},seen:async()=>await call('fixture/seen',{}) as any[]});}finally{await owner.dispose();}
});}
test('real native thread/start hands durable first prompt to real queue and duplicate never creates again',{timeout:15000},async t=>fixture(t,async f=>{
 const result=await f.executor.execute(context(),'raw');assert.equal(result.text,'In progress\nmessage: raw');assert.equal(f.bridge.selectedThreadId(),'new-thread');assert.deepEqual((await f.seen()).map(x=>x.method),['thread/start','turn/start']);
 const ingress=await state.ingressByOrigin(f.path,30n);assert.equal(ingress?.state,'owned');assert.equal(ingress?.targetThreadId,'new-thread');assert.ok(ingress?.ownerId);const jobs=await state.listFiltered(f.path,'new-thread',null);assert.equal(jobs.length,1);assert.equal(jobs[0]?.prompt,'raw enriched');assert.equal(jobs[0]?.turnId,'new-turn');
 await f.executor.execute(context(),'raw');assert.deepEqual((await f.seen()).map(x=>x.method),['thread/start','turn/start']);
}));
test('missing creation id holds original attempt and repeat cannot start another remote thread',{timeout:15000},async t=>fixture(t,async f=>{
 await f.mode('missing');await assert.rejects(f.executor.execute(context(),'raw'),/thread\/start returned no thread id/);const original=await state.ingressByOrigin(f.path,30n);assert.equal(original?.state,'held');assert.equal(original?.ownerId,null);await assert.rejects(f.executor.execute(context(),'raw'),/already attempted/);assert.deepEqual((await f.seen()).map(x=>x.method),['thread/start']);assert.equal(f.bridge.selectedThreadId(),null);
}));
test('cancellation after native creation bytes preserves unknown original and never starts first turn',{timeout:15000},async t=>fixture(t,async f=>{
 await f.mode('hang');const controller=new AbortController(),reason=new Error('shutdown');const pending=f.executor.execute(context(),'raw',controller.signal),checked=assert.rejects(pending,/manual review/);
 for(let n=0;;n++){if((await f.seen()).some(x=>x.method==='thread/start'))break;if(n>100)assert.fail('creation did not start');await new Promise<void>(r=>setImmediate(r));}
 await assert.rejects(f.executor.execute(context(),'raw'),/already attempted/);assert.equal((await state.ingressByOrigin(f.path,30n))?.state,'executing');
 controller.abort(reason);await checked;assert.equal((await state.ingressByOrigin(f.path,30n))?.state,'held');assert.deepEqual(await state.listFiltered(f.path,null,null),[]);assert.deepEqual((await f.seen()).map(x=>x.method),['thread/start']);
}));
test('conflicting repeated prompt is rejected before any new native call',{timeout:15000},async t=>fixture(t,async f=>{
 await f.executor.execute(context(),'raw');await assert.rejects(f.executor.execute(context(),'changed'),/different original channel, user, command, or prompt/);assert.deepEqual((await f.seen()).map(x=>x.method),['thread/start','turn/start']);
}));

test('uncertain mirror creation retains known thread id and never falls back to the original channel',{timeout:15000},async t=>fixture(t,async f=>{
 const db=await openInitialized(f.path);try{db.prepare('INSERT INTO mirror_projects VALUES (?,?,?,?)').run(dirname(f.path),'project',99n,1);}finally{db.close();}
 let links=0;const executor=f.make({linkNewThread:async(_channel,thread)=>{links++;assert.equal(thread,'new-thread');assert.equal((await state.ingressByOrigin(f.path,30n))?.targetThreadId,thread);throw new Error('Discord create unknown');}});
 await assert.rejects(executor.execute(context(),'raw'),/Discord create unknown/);const saved=await state.ingressByOrigin(f.path,30n);assert.equal(saved?.targetThreadId,'new-thread');assert.equal(saved?.state,'held');assert.equal(saved?.ownerId,null);assert.equal(links,1);assert.deepEqual(await state.listPromptIntakes(f.path),[]);assert.deepEqual((await f.seen()).map(x=>x.method),['thread/start']);
}));
test('caller context mutation cannot replace original actor after asynchronous admission starts',{timeout:15000},async t=>fixture(t,async f=>{
 const c=context(),pending=f.executor.execute(c,'raw');c.userId=21n;c.channelId=100n;await pending;const saved=await state.ingressByOrigin(f.path,30n);assert.equal(saved?.ownerUserId,20n);assert.equal(saved?.channelId,99n);
}));
