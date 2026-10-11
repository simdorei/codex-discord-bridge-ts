import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {dirname,join} from 'node:path';import {existsSync,readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {prepareRuntimeContext,type RuntimeStartupContextOptions} from '../../../src/runtime/discord-runtime/startup-context.ts';import {AdmissionGate} from '../../../src/admission/drain-gate.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';import {RuntimeResidentStartupCleanupError} from '../../../src/runtime/discord-runtime/resident-startup.ts';
const render=(e:unknown)=>e instanceof Error?e.message:'opaque';
async function input(mirrorDb:string){const root=dirname(mirrorDb),stateDb=join(root,'codex.sqlite'),db=new DatabaseSync(stateDb);db.exec('CREATE TABLE original(value)');db.close();const pidfile=join(root,'pid');
 const script=`import fs from 'node:fs';import readline from 'node:readline';fs.writeFileSync(${JSON.stringify(pidfile)},String(process.pid));readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});`;
 return {paths:{root,stateDb,mirrorDb,bridgeState:join(root,'bridge.json')},process:{process:{executable:process.execPath,arguments:['--input-type=module','-e',script],environment:{}},clientInfo:{name:'context',title:'fixture',version:'1'}},runtimeId:'runtime',startupChannel:null,admission:new AdmissionGate(),executor:{render,preparePrompt:async()=>{throw Error('unexpected preprocessing');},mirror:null,reportNewAttempt:()=>{},reportPolicyFailure:()=>{},notifyDeliveryReady:()=>{},resumeTimeoutMs:1000,historyTimeoutMs:1000},access:{allowedChannelIds:new Set([1n]),allowedUserIds:new Set([2n]),allowAllChannels:false as boolean},reserveLimits:{maxRows:128,maxBytes:1048576},policyLimits:{maxRows:100n,maxValueBytes:65536n,maxOutputIds:200,timeoutMs:5000},storageTimeoutMs:5000} satisfies RuntimeStartupContextOptions;
}
const decision=(p:Awaited<ReturnType<typeof prepareRuntimeContext>>['policy'],channel:string,user='2')=>p.evaluate(decodeGatewayInteraction(JSON.stringify({application_id:'4',id:'3',token:'fixture',type:2,authorizing_integration_owners:{},channel_id:channel,user:{id:user,username:'u',discriminator:'0001'},data:{id:'9',name:'help',type:1}}))).kind;
async function mappings(path:string){const db=await openInitialized(path);try{db.exec("INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at)VALUES('a','p','a',8,7,1),('b','p','b',9,10,1)");}finally{db.close();}}
function gone(root:string){const pid=Number(readFileSync(join(root,'pid'),'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}

test('actual pre-gateway context captures all paths, static policy and callbacks before native preparation',async()=>storeFixture(async path=>{
 const o=await input(path),originalRoot=o.paths.root,originalBridge=o.paths.bridgeState;let wakes=0,callbackThis:unknown;o.executor.notifyDeliveryReady=function(this:object){callbackThis=this;wakes++;};await mappings(path);
 const pending=prepareRuntimeContext(o);o.paths.bridgeState=join(originalRoot,'foreign.json');o.access.allowedChannelIds.clear();o.access.allowedChannelIds.add(99n);o.access.allowedUserIds.clear();o.access.allowAllChannels=true;o.executor.notifyDeliveryReady=()=>assert.fail('replaced callback');o.policyLimits.maxRows=0n;o.process.process.executable='/does-not-exist';
 const context=await pending;
 try{assert.equal(context.queue.dbPath,path);assert.equal(context.bridge.path(),originalBridge);assert.equal(context.owner.instanceId,context.backend.residentInstanceId());assert.equal(decision(context.policy,'1'),'Allowed');assert.equal(decision(context.policy,'7'),'Allowed');assert.equal(decision(context.policy,'99'),'DeniedChannel');assert.equal(decision(context.policy,'1','3'),'DeniedUser');context.executor.notifyDeliveryReady();assert.equal(wakes,1);assert.equal(callbackThis,context.queue);let delivered=0;context.deliveryWake.bind(()=>{delivered++;});assert.equal(delivered,1);context.executor.notifyDeliveryReady();assert.equal(delivered,2);assert.equal(wakes,2);assert.equal(existsSync(o.paths.bridgeState),false);}
 finally{await context.disposeBeforeWorkers();}gone(originalRoot);assert.deepEqual(context.completionReceiver.tryReceive(),{kind:'Closed'});assert.deepEqual(context.serverRequestReceiver.tryReceive(),{kind:'Closed'});await context.disposeBeforeWorkers();
}));

test('late policy budget failure closes the exact native child while retaining committed startup evidence',async()=>storeFixture(async path=>{
 const o=await input(path);await mappings(path);o.policyLimits.maxRows=1n;
 await assert.rejects(prepareRuntimeContext(o),/policy|budget|limit/i);gone(o.paths.root);
 const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cdr_async_recovery_policies").get()!.n,1);}finally{db.close();}
}));

test('cleanup failure retains the owned resident and both errors for explicit cleanup retry',async()=>storeFixture(async path=>{
 const o=await input(path);await mappings(path);o.policyLimits.maxRows=1n;const original=PortableResidentLifecycle.start,cleanup=new Error('fixture cleanup unavailable');let owner:PortableResidentLifecycle|undefined;
 PortableResidentLifecycle.start=async function(...args:Parameters<typeof original>){owner=await original.apply(this,args);Object.defineProperty(owner,'dispose',{configurable:true,value:async()=>{throw cleanup;}});return owner;};
 try{await assert.rejects(prepareRuntimeContext(o),e=>{assert.ok(e instanceof RuntimeResidentStartupCleanupError);assert.equal(e.owner,owner);assert.equal(e.errors[1],cleanup);return true;});}
 finally{PortableResidentLifecycle.start=original;if(owner){delete (owner as unknown as {dispose?:unknown}).dispose;await PortableResidentLifecycle.prototype.dispose.call(owner);}}gone(o.paths.root);
}));

test('invalid explicit preprocessor and preabort reject before bridge creation or child launch',async()=>storeFixture(async path=>{
 const o=await input(path);const a=new AbortController(),reason=new Error('stop');a.abort(reason);await assert.rejects(prepareRuntimeContext(o,a.signal),e=>e===reason);await assert.rejects(prepareRuntimeContext({...o,executor:{...o.executor,preparePrompt:undefined}} as never),TypeError);assert.equal(existsSync(path),false);assert.equal(existsSync(join(o.paths.root,'pid')),false);
}));

test('actual startup queue wake binds once to actual completion pipeline and detaches after joined stop',{timeout:15000},async()=>storeFixture(async path=>{
 const {httpFixture}=await import('../../helpers/interaction-worker-fixture.ts'),{startCompletionRuntimeWorker}=await import('../../../src/runtime/discord-runtime/completion-start.ts'),{RuntimeWorkerExitChannel}=await import('../../../src/runtime/discord-runtime/monitored-worker.ts'),{CompletionPipeline}=await import('../../../src/runtime/completion/pipeline.ts');
 const options=await input(path);let userWakes=0;options.executor.notifyDeliveryReady=()=>{userWakes++;};const context=await prepareRuntimeContext(options),stop=new AbortController(),exits=new RuntimeWorkerExitChannel();
 const original=CompletionPipeline.prototype.notifyDeliveryReady;let pipelineWakes=0;CompletionPipeline.prototype.notifyDeliveryReady=function(){pipelineWakes++;return original.call(this);};
 try{await httpFixture(async(http,seen)=>{context.queue.notifyDeliveryReady();assert.equal(userWakes,1);assert.equal(pipelineWakes,0);const bound=await startCompletionRuntimeWorker(context,http,{commentaryEnabled:false,historyReadTimeoutMs:1000,render:()=> 'safe',report:()=>{}},stop.signal,exits);
  try{assert.equal(pipelineWakes,1);context.executor.notifyDeliveryReady();assert.equal(pipelineWakes,2);assert.equal(userWakes,2);}finally{stop.abort();await bound.worker.join();}
  context.queue.notifyDeliveryReady();assert.equal(pipelineWakes,2);assert.equal(userWakes,3);assert.deepEqual(seen,[]);assert.equal(http.activeRequests,0);
 });}finally{stop.abort();CompletionPipeline.prototype.notifyDeliveryReady=original;exits.close();await context.disposeBeforeWorkers();}gone(options.paths.root);
}));


test('prepared core assembly starts six exact workers and joins them while shared native/HTTP remain owned',{timeout:15000},async()=>storeFixture(async path=>{
 const {httpFixture}=await import('../../helpers/interaction-worker-fixture.ts'),{startRuntimeCoreWorkers}=await import('../../../src/runtime/discord-runtime/core-workers-start.ts'),{RuntimeWorkerExitChannel}=await import('../../../src/runtime/discord-runtime/monitored-worker.ts');
 const o=await input(path),context=await prepareRuntimeContext(o),stop=new AbortController(),exits=new RuntimeWorkerExitChannel(),errors:unknown[]=[];
 try{await httpFixture(async(http,seen)=>{const core=await startRuntimeCoreWorkers(context,http,o.admission,stop.signal,exits,{commentaryEnabled:false,historyReadTimeoutMs:1000,render:()=> 'safe',report:e=>{errors.push(e);}});
  try{assert.deepEqual(core.workers.map(w=>w.name),['app-server-supervisor','completion','new-first-reply-verification','stop-control','prompt-intake-recovery','server-request']);await assert.rejects(startRuntimeCoreWorkers(context,http,o.admission,stop.signal,exits,{commentaryEnabled:false,historyReadTimeoutMs:1000,render:()=> 'safe',report:()=>{}}),/already bound/);context.executor.notifyDeliveryReady();}
  finally{core.requestStop();const a=core.close(),b=core.close();assert.equal(a,b);for(const result of await a)assert.deepEqual(result,{kind:'Returned',result:{ok:true}});}
  assert.equal(context.owner.lifecycleSnapshot().healthy,true);assert.equal(context.completionReceiver.tryReceive().kind,'Closed');assert.equal(context.serverRequestReceiver.tryReceive().kind,'Closed');assert.equal(http.activeRequests,0);assert.deepEqual(seen,[]);assert.deepEqual(errors,[]);
 });}finally{stop.abort();exits.close();await context.disposeBeforeWorkers();}gone(o.paths.root);
}));
test('foreign gate or queue is rejected before consuming startup receivers',{timeout:15000},async()=>storeFixture(async path=>{
 const {httpFixture}=await import('../../helpers/interaction-worker-fixture.ts'),{startRuntimeCoreWorkers}=await import('../../../src/runtime/discord-runtime/core-workers-start.ts'),{RuntimeWorkerExitChannel}=await import('../../../src/runtime/discord-runtime/monitored-worker.ts'),{QueueStartCoordinator}=await import('../../../src/runtime/queue-runner/start-coordinator.ts');
 const o=await input(path),context=await prepareRuntimeContext(o),exits=new RuntimeWorkerExitChannel(),stop=new AbortController(),options={commentaryEnabled:false,historyReadTimeoutMs:1000,render:()=> 'safe',report:()=>{}};
 try{await httpFixture(async(http,seen)=>{await assert.rejects(startRuntimeCoreWorkers(context,http,new AdmissionGate(),stop.signal,exits,options),/admission gate differs/);const other=new QueueStartCoordinator(path,context.backend,{admission:o.admission});await assert.rejects(startRuntimeCoreWorkers({...context,queue:other},http,o.admission,stop.signal,exits,options),/executor queue differs/);await assert.rejects(startRuntimeCoreWorkers(context,http,o.admission,stop.signal,exits,{...options,historyReadTimeoutMs:-1}),/Invalid core completion options/);const cancelled=new AbortController(),reason=new Error('cancelled before core');cancelled.abort(reason);await assert.rejects(startRuntimeCoreWorkers(context,http,o.admission,cancelled.signal,exits,options),e=>e===reason);assert.equal(context.completionReceiver.tryReceive().kind,'Empty');assert.equal(context.serverRequestReceiver.tryReceive().kind,'Empty');assert.deepEqual(seen,[]);});}finally{exits.close();await context.disposeBeforeWorkers();}
}));
test('partial core start failure joins accepted workers and disposes both original receivers',{timeout:15000},async()=>storeFixture(async path=>{
 const {httpFixture}=await import('../../helpers/interaction-worker-fixture.ts'),{startRuntimeCoreWorkers,RuntimeCoreWorkerStartError}=await import('../../../src/runtime/discord-runtime/core-workers-start.ts'),{RuntimeWorkerExitChannel}=await import('../../../src/runtime/discord-runtime/monitored-worker.ts');
 const o=await input(path),context=await prepareRuntimeContext(o),exits=new RuntimeWorkerExitChannel(),stop=new AbortController(),primary=new Error('third worker allocation failed'),original=RuntimeWorkerExitChannel.prototype.acquire;let calls=0;
 RuntimeWorkerExitChannel.prototype.acquire=function(){if(++calls===3)throw primary;return original.call(this);};
 try{await httpFixture(async(http,seen)=>{await assert.rejects(startRuntimeCoreWorkers(context,http,o.admission,stop.signal,exits,{commentaryEnabled:false,historyReadTimeoutMs:1000,render:()=> 'safe',report:()=>{}}),e=>{assert.ok(e instanceof RuntimeCoreWorkerStartError);assert.equal(e.errors[0],primary);assert.equal(e.joined.length,2);return true;});assert.equal(context.completionReceiver.tryReceive().kind,'Closed');assert.equal(context.serverRequestReceiver.tryReceive().kind,'Closed');assert.equal(context.owner.lifecycleSnapshot().healthy,true);assert.equal(http.activeRequests,0);assert.deepEqual(seen,[]);});}
 finally{RuntimeWorkerExitChannel.prototype.acquire=original;stop.abort();exits.close();await context.disposeBeforeWorkers();}
}));
