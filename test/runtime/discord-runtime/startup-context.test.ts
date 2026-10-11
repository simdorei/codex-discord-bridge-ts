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
 const o=await input(path),originalRoot=o.paths.root,originalBridge=o.paths.bridgeState;let wakes=0;o.executor.notifyDeliveryReady=()=>{wakes++;};await mappings(path);
 const pending=prepareRuntimeContext(o);o.paths.bridgeState=join(originalRoot,'foreign.json');o.access.allowedChannelIds.clear();o.access.allowedChannelIds.add(99n);o.access.allowedUserIds.clear();o.access.allowAllChannels=true;o.executor.notifyDeliveryReady=()=>assert.fail('replaced callback');o.policyLimits.maxRows=0n;o.process.process.executable='/does-not-exist';
 const context=await pending;
 try{assert.equal(context.queue.dbPath,path);assert.equal(context.bridge.path(),originalBridge);assert.equal(context.owner.instanceId,context.backend.residentInstanceId());assert.equal(decision(context.policy,'1'),'Allowed');assert.equal(decision(context.policy,'7'),'Allowed');assert.equal(decision(context.policy,'99'),'DeniedChannel');assert.equal(decision(context.policy,'1','3'),'DeniedUser');context.executor.notifyDeliveryReady();assert.equal(wakes,1);assert.equal(existsSync(o.paths.bridgeState),false);}
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
