import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,renameSync} from 'node:fs';
import {dirname,relative} from 'node:path';
import {promptFixture} from '../../helpers/server-prompt-fixture.ts';
import {setupPromptRuntime} from '../../helpers/native-server-prompt-runtime-fixture.ts';
import {httpFixture} from '../../helpers/interaction-worker-fixture.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
import {createPreparedInteractionIngress} from '../../../src/runtime/discord-runtime/interaction-ingress-bootstrap.ts';
import {createOrdinaryInteractionHandler} from '../../../src/runtime/discord-runtime/ordinary-interaction-handler.ts';
import {createNativeMirrorPolicyRefresh,refreshMirrorPolicyOffThread,takeMirrorPolicyCapacityRefusal,NativeMirrorPolicyError} from '../../../src/runtime/discord-runtime/native-mirror-policy.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {createInteractionWorkQueue,releaseInboundInteractionWork} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {AutocompleteCatalog} from '../../../src/runtime/discord-dispatch/autocomplete.ts';
import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {GatewayIngressLane} from '../../../src/discord/gateway/lane.ts';
import {runInteractionLane,type OwnedInteractionIngress} from '../../../src/runtime/discord-runtime/interaction-lane.ts';
import {reportInteractionEventResult,type InteractionFailureReport} from '../../../src/runtime/discord-runtime/interaction-failure.ts';
import {interactionDispatchErrorInfo} from '../../../src/runtime/discord-dispatch/errors.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,OwnedWorkerTimeoutError,ownedWorkerUsage,takeOwnedWorkerAdmissionRefusal} from '../../../src/runtime/owned-worker-slot.ts';
import {nativeGatewayShutdownClock} from '../../../src/discord/gateway/shutdown.ts';
import {DrainFenceKey} from '../../../src/admission/drain-gate.ts';
const limits={maxRows:100n,maxValueBytes:65536n,maxOutputIds:200,timeoutMs:5000};
const workerName='discord-runtime/mirror-policy-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts');
const item=(id=9007199254740993n,tag:OwnedInteractionIngress['tag']='Normal',channel=1n,user=2n):OwnedInteractionIngress=>({event:decodeGatewayInteraction(JSON.stringify({application_id:'4',authorizing_integration_owners:{},channel_id:String(channel),id:String(id),token:'offline_token',type:2,user:{id:String(user),username:'u',discriminator:'0001'},data:{id:'9',name:'help',type:1}})),tag,sequence:id,receivedAtMs:performance.now()});
async function until(check:()=>boolean){const end=performance.now()+8000;while(!check()){assert.ok(performance.now()<end,'fixture condition deadline');await new Promise(r=>setTimeout(r,5));}}
function sql(path:string,text:string){const db=new DatabaseSync(path);try{db.exec(text);}finally{db.close();}}
function count(path:string){const db=new DatabaseSync(path);try{return db.prepare('SELECT count(*) AS n FROM discord_ingress_journal').get()!.n;}finally{db.close();}}
function take(queue:ReturnType<typeof createInteractionWorkQueue>){const got=queue.receiver.tryReceive();assert.equal(got.kind,'Value');if(got.kind==='Value'){const id=got.value.interactionId;releaseInboundInteractionWork(got.value);return id;}throw Error('missing fixture work');}
async function fixture(run:(c:{f:ReturnType<typeof setupPromptRuntime>;http:Parameters<typeof createPreparedInteractionIngress>[3];seen:string[];queue:ReturnType<typeof createInteractionWorkQueue>;handler:ReturnType<typeof createPreparedInteractionIngress>})=>Promise<void>,nativeLimits=limits){
 await promptFixture(async(path,server)=>{const f=setupPromptRuntime(path,server);await httpFixture(async(http,seen)=>{const queue=createInteractionWorkQueue(),handler=createPreparedInteractionIngress(f.startup,f.gate,queue,http,new AutocompleteCatalog(),false,()=>{},nativeLimits);try{await run({f,http,seen,queue,handler});}finally{queue.receiver.dispose();queue.sender.dispose();}assert.equal(ownedWorkerUsage().Background,0);});});
}
const capacity=(e:unknown)=>interactionDispatchErrorInfo(e)?.kind==='Capacity';
function fatal(error:unknown){assert.equal(capacity(error),false);assert.equal(takeMirrorPolicyCapacityRefusal(undefined,error),false);assert.deepEqual(reportInteractionEventResult('normal-interaction',3n,'offline_token',{ok:false,error},()=>assert.fail('fatal error reported as event-local')),{ok:false,error});return true;}

test('installed ordinary ingress uses complete native policy with poisoned facade and main SQLite, replaces mappings and preserves static user rules',async t=>fixture(async c=>{
 const channel=9007199254740995n;sql(c.f.path,`INSERT INTO mirror_threads VALUES ('fresh','p','Fresh',10,${channel},1)`);
 const poison=t.mock.method(DatabaseSync.prototype,'prepare',()=>assert.fail('main-thread SQLite policy/journal read'));
 const facade=['remainingDiscordIds','mirrorTargets'] as const,poisons=facade.map(key=>t.mock.method(state,key,()=>assert.fail(`compatibility ${key}`)));
 try{await c.handler(item(undefined,'Normal',channel),new AbortController().signal);assert.equal(take(c.queue),9007199254740993n);}finally{poison.mock.restore();for(const mock of poisons)mock.mock.restore();}
 assert.equal(count(c.f.path),1);sql(c.f.path,"DELETE FROM mirror_threads WHERE codex_thread_id='fresh'");
 await c.handler(item(9007199254740994n,'Normal',channel),new AbortController().signal);assert.equal(c.queue.snapshot().queued,0);assert.equal(count(c.f.path),1);
 await c.handler(item(9007199254740995n,'Normal',1n,3n),new AbortController().signal);assert.equal(count(c.f.path),1);
 await c.handler(item(9007199254740996n),new AbortController().signal);take(c.queue);assert.equal(count(c.f.path),2);assert.equal(c.seen.length,4);
}));

test('real Normal/Reserved overlap refuses only the second event while first owns exit; later event refreshes again',async()=>fixture(async c=>{
 const normal=new GatewayIngressLane<OwnedInteractionIngress>(8),reserved=new GatewayIngressLane<OwnedInteractionIngress>(8),stop=new AbortController(),force=new AbortController(),reports:InteractionFailureReport[]=[],done:bigint[]=[];
 const shared:typeof c.handler=async(input,signal)=>{await c.handler(input,signal);done.push(input.event.id);};
 const jobs=[runInteractionLane('Normal',normal.receiver(),shared,stop.signal,force.signal,{report:r=>{reports.push(r);}}),runInteractionLane('Reserved',reserved.receiver(),shared,stop.signal,force.signal,{report:r=>{reports.push(r);}})];for(const p of jobs)void p.catch(()=>{});
 const trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:workerName,trace});
 try{normal.trySend(item());await waitTrace(trace);assert.equal(ownedWorkerUsage().Background,1);reserved.trySend(item(9007199254740994n,'Busy'));await until(()=>reports.length===1);
  assert.equal(reports[0]!.lane,'reserved-interaction');assert.equal(reports[0]!.interactionId,9007199254740994n);assert.match(reports[0]!.error,/refused before persistence.*policy capacity/);assert.deepEqual(c.seen,[]);assert.equal(count(c.f.path),0);assert.equal(c.queue.snapshot().queued,0);
  restore();releaseTrace(trace);await until(()=>done.length===1);take(c.queue);assert.equal(count(c.f.path),1);
  // Reusing the refused ID proves no claim was created. Delete the mapping so a
  // fresh refresh denies the later event rather than reusing the first result.
  sql(c.f.path,'DELETE FROM mirror_threads');reserved.trySend(item(9007199254740994n,'Busy',10n));await until(()=>done.length===2);assert.equal(c.seen.length,2);assert.equal(c.queue.snapshot().queued,0);assert.equal(count(c.f.path),1);assert.equal(reports.length,1);
 }finally{restore();releaseTrace(trace);stop.abort();normal.close();reserved.close();await Promise.all(jobs);}
}));

const waitingWorker=new URL('data:text/javascript,'+encodeURIComponent("import {parentPort,workerData} from 'node:worker_threads';Atomics.wait(new Int32Array(workerData),0,0,15000);parentPort.postMessage(true);"));
async function saturate(run:(slots:OwnedWorkerSlot[])=>Promise<void>){const shared=new SharedArrayBuffer(4),slots=[new OwnedWorkerSlot(),new OwnedWorkerSlot(),new OwnedWorkerSlot()],tasks=slots.map(s=>s.run(waitingWorker,shared,10000));try{assert.equal(ownedWorkerUsage().Background,3);await run(slots);}finally{Atomics.store(new Int32Array(shared),0,1);Atomics.notify(new Int32Array(shared),0);await Promise.all(tasks);await Promise.all(slots.map(s=>s.join()));}}
test('unrelated Background saturation refuses before policy submission, journal, claim or ACK, and later recovers',async()=>fixture(async c=>{
 await saturate(async()=>{await assert.rejects(c.handler(item(),new AbortController().signal),capacity);assert.equal(count(c.f.path),0);assert.deepEqual(c.seen,[]);assert.equal(c.queue.snapshot().queued,0);});
 await c.handler(item(),new AbortController().signal);take(c.queue);assert.equal(count(c.f.path),1);assert.equal(c.seen.length,1);
}));

test('admission proof is exact-owner exact-Promise and single-use; public budget errors are unbranded',async()=>saturate(async()=>{
 const slot=new OwnedWorkerSlot(),pending=slot.run(waitingWorker,new SharedArrayBuffer(4),1000);let error:unknown;try{await pending;}catch(e){error=e;}
 assert.equal(takeOwnedWorkerAdmissionRefusal(new OwnedWorkerSlot(),pending,error),false);assert.equal(takeOwnedWorkerAdmissionRefusal(slot,Promise.resolve(),error),false);assert.equal(takeOwnedWorkerAdmissionRefusal(slot,pending,new OwnedWorkerBudgetError()),false);assert.equal(takeOwnedWorkerAdmissionRefusal(slot,pending,error),true);assert.equal(takeOwnedWorkerAdmissionRefusal(slot,pending,error),false);assert.equal(takeMirrorPolicyCapacityRefusal(undefined,error),false);
}));

for(const mode of ['public-budget','forged-budget','post-submission'] as const)test(`${mode} policy failure remains fatal with no ACK or admission`,async t=>fixture(async c=>{
 const original=OwnedWorkerSlot.prototype.run,error=mode==='forged-budget'?Object.assign(Error('capacity is occupied'),{name:'NativeMirrorPolicyCapacityError'}):new OwnedWorkerBudgetError();
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){if(!String(args[0]).includes('/mirror-policy-worker.'))return original.apply(this,args);if(mode==='post-submission'){const pending=original.apply(this,args);return pending.then(()=>{throw error;});}return Promise.reject(error);});
 await assert.rejects(c.handler(item(),new AbortController().signal),e=>e===error&&fatal(e));assert.equal(count(c.f.path),0);assert.deepEqual(c.seen,[]);assert.equal(c.queue.snapshot().queued,0);
}));

for(const mode of ['cancel','timeout'] as const)test(`SQLite lock ${mode} keeps slot until real worker exit and never ACKs`,async()=>fixture(async c=>{
 const db=new DatabaseSync(c.f.path);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');
 const trace=new SharedArrayBuffer(12),restore=instrumentStoreWorker({match:workerName,trace,before:'Atomics.store(trace,0,1);',after:'Atomics.store(trace,2,1);Atomics.wait(trace,1,0,15000);'});
 const abort=new AbortController(),reason=Error('fixture cancellation');let settled=false;const pending=c.handler(item(),abort.signal);void pending.then(()=>settled=true,()=>settled=true);
 try{await waitTrace(trace);if(mode==='cancel')abort.abort(reason);await new Promise(r=>setTimeout(r,60));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Background,1);await assert.rejects(c.handler(item(9007199254740994n,'Busy'),new AbortController().signal),capacity);assert.deepEqual(c.seen,[]);assert.equal(c.queue.snapshot().queued,0);
  // The cancellation/timeout is observed before the DB worker finishes, then
  // actual exit remains independently held even after the SQLite lock resolves.
  db.exec('ROLLBACK');await new Promise(r=>setTimeout(r,80));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Background,1);restore();releaseTrace(trace);
  await assert.rejects(pending,e=>(mode==='cancel'?e===reason:e instanceof OwnedWorkerTimeoutError)&&fatal(e));assert.equal(ownedWorkerUsage().Background,0);assert.equal(count(c.f.path),0);
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();restore();releaseTrace(trace);await pending.catch(()=>{});}
},mode==='timeout'?{...limits,timeoutMs:25}:limits));

test('late complete policy keeps original ACK deadline and enters no admission gate',async()=>fixture(async c=>{
 const trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:workerName,trace});const pending=c.handler({...item(),receivedAtMs:performance.now()-2400},new AbortController().signal);
 try{await waitTrace(trace);await new Promise(r=>setTimeout(r,150));restore();releaseTrace(trace);await pending;assert.deepEqual(c.seen,[]);assert.equal(count(c.f.path),0);assert.equal(c.queue.snapshot().queued,0);const fence=DrainFenceKey.create('late','1|2','fixture');c.f.gate.seal(fence);assert.equal(c.f.gate.isDrainedFor(fence),true);}finally{restore();releaseTrace(trace);await pending.catch(()=>{});}
}));

for(const mode of ['rows','values','output','malformed','incompatible'] as const)test(`installed ${mode} policy fails completely even for expired ingress`,async()=>fixture(async c=>{
 if(mode==='rows')sql(c.f.path,"INSERT INTO mirror_threads VALUES ('extra','p','Extra',10,2,2)");if(mode==='malformed')sql(c.f.path,"UPDATE mirror_threads SET discord_thread_id=1.5");if(mode==='incompatible')sql(c.f.path,'DROP TABLE mirror_projects');
 await assert.rejects(c.handler({...item(),receivedAtMs:0},new AbortController().signal),e=>e instanceof NativeMirrorPolicyError&&fatal(e));assert.equal(count(c.f.path),0);assert.deepEqual(c.seen,[]);assert.equal(c.queue.snapshot().queued,0);
},mode==='rows'?{...limits,maxRows:1n}:mode==='values'?{...limits,maxValueBytes:1n}:mode==='output'?{...limits,maxOutputIds:1}:limits));

test('installed limits are captured before mutation and reject a complete oversize result',async()=>{
 const mutable={...limits,maxOutputIds:1};await fixture(async c=>{mutable.maxOutputIds=200;await assert.rejects(c.handler(item(),new AbortController().signal),e=>e instanceof NativeMirrorPolicyError&&fatal(e));assert.deepEqual(c.seen,[]);assert.equal(count(c.f.path),0);},mutable);
});

test('handler captures original refresh callback, metadata, database and clock methods before await',async()=>fixture(async c=>{
 let offset=0;const clock={now:()=>performance.now()+offset,sleepUntil:nativeGatewayShutdownClock.sleepUntil},refresh=createNativeMirrorPolicyRefresh(c.f.path,limits),options={client:c.http,queue:c.queue,policy:c.f.startup.policy,clock,database:c.f.path,qaEnabled:false,admission:c.f.gate,autocomplete:new AutocompleteCatalog(),settingsResolver:null,report:()=>{},refreshPolicy:refresh};
 const handler=createOrdinaryInteractionHandler(options),trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:workerName,trace}),input={...item()},pending=handler(input,new AbortController().signal);
 try{await waitTrace(trace);options.database='/unrelated/never-created';options.refreshPolicy=async()=>{throw Error('replaced callback');};options.report=()=>{throw Error('replaced reporter');};clock.now=()=>0;input.receivedAtMs=performance.now()+10000;input.event=item(4n).event;offset=10000;restore();releaseTrace(trace);await pending;assert.deepEqual(c.seen,[]);assert.equal(count(c.f.path),0);}finally{restore();releaseTrace(trace);await pending.catch(()=>{});}
}));

test('native refresh port pins relative original path, rejects replacement path and missing stores without creation',async()=>storeFixture(async path=>{
 const base=new InteractionAccessPolicy({allowedChannelIds:[1n],allowedUserIds:[],mirroredChannelIds:[],allowAllChannels:false}),original=process.cwd(),name=relative(original,path),port=createNativeMirrorPolicyRefresh(name,limits);
 assert.throws(()=>port(base,path,new AbortController().signal),/another database/);
 try{process.chdir(dirname(path));await assert.rejects(port(base,name,new AbortController().signal),NativeMirrorPolicyError);}finally{process.chdir(original);}
 assert.equal(existsSync(path),false);
 for(const value of ['bad\0path','\ud800','x'.repeat(32769)])assert.throws(()=>createNativeMirrorPolicyRefresh(value,limits));
 let hooks=0;assert.throws(()=>createNativeMirrorPolicyRefresh(path,{get maxRows(){hooks++;return 1n;},maxValueBytes:1n,maxOutputIds:1,timeoutMs:1}),TypeError);assert.equal(hooks,0);
 assert.equal(takeMirrorPolicyCapacityRefusal(undefined,new OwnedWorkerBudgetError()),false);
}));


test('installed missing database fails without initializing or stale policy ACK',async()=>fixture(async c=>{
 const saved=c.f.path+'.saved';renameSync(c.f.path,saved);
 try{await assert.rejects(c.handler(item(),new AbortController().signal),e=>e instanceof NativeMirrorPolicyError&&fatal(e));assert.equal(existsSync(c.f.path),false);assert.deepEqual(c.seen,[]);assert.equal(c.queue.snapshot().queued,0);}finally{renameSync(saved,c.f.path);}
}));

for(const output of ['{ok:true,ids:[1]}','{ok:true,ids:[2n,1n]}','{ok:true,ids:[1n,1n]}','{ok:true,ids:[1n<<63n]}','{ok:false,detail:"fixture SQL/budget failure"}'])test(`malformed/failed native policy output remains fatal: ${output}`,async()=>fixture(async c=>{
 const trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:workerName,trace,before:`parentPort.postMessage=()=>post(${output});`,after:''});
 try{await assert.rejects(c.handler(item(),new AbortController().signal),fatal);assert.equal(count(c.f.path),0);assert.deepEqual(c.seen,[]);}finally{restore();}
}));


for(const mode of ['unsubmitted','admitted','custom-refresh'] as const)test(`old genuine native capacity error replay stays fatal for ${mode} invocation`,async t=>fixture(async c=>{
 let old:unknown;await saturate(async()=>{try{await refreshMirrorPolicyOffThread(c.f.startup.policy,c.f.path,limits);}catch(error){old=error;}});assert.ok(old instanceof Error);
 const run=OwnedWorkerSlot.prototype.run;
 const handler=mode==='custom-refresh'?createOrdinaryInteractionHandler({client:c.http,queue:c.queue,policy:c.f.startup.policy,database:c.f.path,qaEnabled:false,admission:c.f.gate,autocomplete:new AutocompleteCatalog(),settingsResolver:null,report:()=>{},refreshPolicy:async()=>{throw old;}}):c.handler;
 if(mode!=='custom-refresh')t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(!String(args[0]).includes('/mirror-policy-worker.'))return run.apply(this,args);return mode==='admitted'?run.apply(this,args).then(()=>{throw old;}):Promise.reject(old);});
 await assert.rejects(handler(item(),new AbortController().signal),e=>e===old&&fatal(e));assert.equal(count(c.f.path),0);assert.deepEqual(c.seen,[]);assert.equal(c.queue.snapshot().queued,0);
}));

test('policy capacity proof is exact refresh Promise and consumed once',async()=>fixture(async c=>{
 await saturate(async()=>{const pending=refreshMirrorPolicyOffThread(c.f.startup.policy,c.f.path,limits);let error:unknown;try{await pending;}catch(e){error=e;}
  assert.equal(takeMirrorPolicyCapacityRefusal(Promise.resolve(c.f.startup.policy),error),false);assert.equal(takeMirrorPolicyCapacityRefusal(pending,new OwnedWorkerBudgetError()),false);assert.equal(takeMirrorPolicyCapacityRefusal(pending,error),true);assert.equal(takeMirrorPolicyCapacityRefusal(pending,error),false);
 });
}));

test('explicit null refresh callback and accessor options reject before any refresh',async()=>fixture(async c=>{
 const options={client:c.http,queue:c.queue,policy:c.f.startup.policy,database:c.f.path,qaEnabled:false,admission:c.f.gate,autocomplete:new AutocompleteCatalog(),settingsResolver:null,report:()=>{}};
 assert.throws(()=>createOrdinaryInteractionHandler({...options,refreshPolicy:null as never}),TypeError);let hooks=0;
 for(const field of ['database','report','refreshPolicy'])assert.throws(()=>createOrdinaryInteractionHandler(Object.defineProperty({...options},field,{get(){hooks++;throw Error('unexpected getter');}})),TypeError);
 assert.equal(hooks,0);assert.deepEqual(c.seen,[]);assert.equal(count(c.f.path),0);
}));
