import {instrumentStoreWorker,waitTrace,releaseTrace} from '../helpers/store-authority-worker-fixture.ts';
import {dirname,relative} from 'node:path';
import {NativeIdleBeforeOwner} from '../../src/runtime/native-idle-before.ts';
import {NativeObservationLedgerOwner} from '../../src/runtime/native-observation-ledger.ts';
import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {existsSync} from "node:fs";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import {IdleObservationError} from "../../src/app-server/notification-state.ts";
import {createRuntimeIdleJournal,installRuntimeIdleJournal,installRuntimeIdleJournalNative} from "../../src/runtime/idle-release-journal.ts";
import {initializeRuntimeCustody} from "../../src/runtime/runtime-custody.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {serializeSerdeValue} from "../../src/core/serde-json.ts";
import {certifyObservationOn} from "../../src/store/observation-proof.ts";
import {selectIdleIntentIn} from "../../src/store/idle-release-row.ts";
import {storeFixture} from "../helpers/store-fixture.ts";
const render=(e:unknown)=>e instanceof Error?e.message:"diagnostic";
interface Fixture{owner:PortableResidentLifecycle;db:DatabaseSync;path:string;call(method:string):Promise<unknown>;current():NonNullable<ReturnType<typeof selectIdleIntentIn>>}
const code=`import readline from 'node:readline';let unloaded=false;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),reply=x=>emit({id:m.id,result:x});if(m.method==='initialized')return;if(m.method==='seed'){emit({method:'turn/completed',params:{threadId:'T',turn:{id:'V',status:'completed'}}});reply({});}else if(m.method==='thread/goal/get')reply({goal:null});else if(m.method==='thread/read')reply({thread:{id:'T',status:{type:unloaded?'notLoaded':'idle'},turns:[{id:'V',status:'completed'}]}});else if(m.method==='thread/unsubscribe'){unloaded=true;reply({status:'unsubscribed'});}else if(m.method==='thread/resume'){unloaded=false;reply({thread:{id:'T'}});}else reply({method:m.method,params:m.params});});`;
async function fixture(t:TestContext,run:(f:Fixture)=>Promise<void>){await storeFixture(async path=>{
  const custody=await initializeRuntimeCustody(path,"runtime",99n,render),db=await openInitialized(path);let owner:PortableResidentLifecycle|undefined;
  try{
    owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},render,{persistDeadWork:custody.persistDeadWork,oldChildExited(){}},t.signal,{fence:custody.fence,renderError:render});
    installRuntimeIdleJournal(owner,path,render);const native=owner;
    db.prepare("INSERT INTO cdr_idle_release(intent_id,owner_id,generation,thread_id,turn_id,job_id,revision,state) VALUES('i',?,1,'T','V','job',1,'Candidate')").run(owner.instanceId);
    await run({owner,db,path,current:()=>selectIdleIntentIn(db,"T")!,call:async method=>{const a=native.admitResponse(1n);try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}}});
  }finally{try{if(owner)await owner.dispose();}finally{db.close();}}
});}
async function reconcile(f:Fixture){
  await f.call("seed");const window=f.owner.observationWindow(1n,0n),event=window.events[0]!.notification!;
  f.owner.markSourceObservationGap(1n,e=>{throw e;});const scope={ownerId:f.owner.instanceId,generation:1n},payload=serializeSerdeValue(event.params);
  // Explicit fixture producer persists the exact event it just received. No unconfirmed
  // event or elapsed time is used as an observation certificate.
  f.db.prepare("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload,resident_owner) VALUES('T','V',1,?,?)").run(payload,f.owner.instanceId);
  assert.equal(certifyObservationOn(f.db,scope,1n,[{kind:"Terminal",thread:"T",turn:"V",payload}]),true);
  assert.equal(f.owner.reconcileIdleObservationPrefix(1n,1n),true);
}
test("actual installed journal requires durable event proof and confirms unload only after a fresh native read",{timeout:15000},async t=>fixture(t,async f=>{
  assert.equal(f.owner.observationTrackingEnabled(),true);await f.call("seed");f.owner.markSourceObservationGap(1n,e=>{throw e;});assert.equal(f.owner.reconcileIdleObservationPrefix(1n,1n),false);
  const event=f.owner.observationWindow(1n,0n).events[0]!.notification!,payload=serializeSerdeValue(event.params);f.db.prepare("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload,resident_owner) VALUES('T','V',1,?,?)").run(payload,f.owner.instanceId);
  assert.equal(certifyObservationOn(f.db,{ownerId:f.owner.instanceId,generation:1n},1n,[{kind:"Terminal",thread:"T",turn:"V",payload}]),true);assert.equal(f.owner.reconcileIdleObservationPrefix(1n,1n),true);
  assert.equal(f.owner.subscriptionResumeRequired("T"),false);await f.owner.releaseIdleSubscription(f.current());assert.equal(f.current().state,"AwaitUnload");assert.equal(f.owner.subscriptionResumeRequired("T"),true);await f.owner.releaseIdleSubscription(f.current());assert.equal(f.current().state,"Settled");assert.equal(f.current().detail,"UnloadedConfirmed");assert.equal(f.owner.subscriptionResumeRequired("T"),false);
}));
test("installed journal performs one real resubscribe before the next ordinary mutation",{timeout:15000},async t=>fixture(t,async f=>{
  await reconcile(f);await f.owner.releaseIdleSubscription(f.current());assert.equal(f.current().state,"AwaitUnload");
  await f.owner.request("thread/settings/update",{threadId:"T",model:"x"},1000,1n);assert.equal(f.current().state,"Settled");assert.equal(f.current().detail,"SupersededByConfirmedResubscribe");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM codex_mutation_attempts WHERE method='thread/resume'").get()!.n,1);
}));
test("unknown observation gap remains held despite later prefix reconciliation",{timeout:15000},async t=>fixture(t,async f=>{
  await reconcile(f);f.owner.markIdleObservationGap(e=>{throw e;});assert.equal(f.owner.reconcileIdleObservationPrefix(1n,1n),false);await assert.rejects(async()=>f.owner.releaseIdleSubscription(f.current()),/unverified/);assert.notEqual(f.current().state,"AwaitUnload");
}));
test("native confirmed old-child exit settles only its matching owner and generation",{timeout:15000},async t=>fixture(t,async f=>{
  f.db.exec("UPDATE cdr_idle_release SET state='Unknown'; INSERT INTO cdr_idle_release VALUES('foreign','other',1,'U','v','j',1,'Unknown','')");await f.owner.close();assert.equal(f.current().state,"Settled");assert.equal(f.current().detail,"OldServerExited");assert.equal(selectIdleIntentIn(f.db,"U")!.state,"Unknown");
}));
test("resumeRequired preserves AwaitUnload shortcut but every other state applies current async policy guard",async()=>storeFixture(async path=>{
  const db=await openInitialized(path);try{
    db.exec("INSERT INTO cdr_idle_release VALUES('i','owner',1,'T','V','job',1,'AwaitUnload','detail'); INSERT INTO cdr_async_recovery_policies VALUES('T',1,'publishing_recovery','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','v','origin','pending')");
    const j=createRuntimeIdleJournal(path,render);assert.equal(j.resumeRequired("T"),true);assert.throws(()=>j.checkMutation("T"),/reviewed publishing recovery policy/);db.exec("UPDATE cdr_idle_release SET state='Settled'");assert.throws(()=>j.resumeRequired("T"),/reviewed publishing recovery policy/);
  }finally{db.close();}
}));
test("existing-only journal rejects missing schema and integer overflow without silently creating a store",async()=>storeFixture(async path=>{
  const j=createRuntimeIdleJournal(path,render);assert.equal(j.tracksObservations(),true);assert.throws(()=>j.resumeRequired("T"),IdleObservationError);assert.equal(existsSync(path),false);
  assert.throws(()=>j.observeSourceUpper("owner",1n,1n<<63n),/signed i64/);assert.equal(existsSync(path),false);assert.equal(Object.isFrozen(j),true);
}));
test("cold scope activation retains prior unresolved idle rows and unknown tails",async()=>storeFixture(async path=>{
  const db=await openInitialized(path);try{
    state.activateObservationExisting(path,{ownerId:"old",generation:1n});db.exec("INSERT INTO cdr_idle_release VALUES('old','old',1,'T','V','job',1,'Unknown','preserve')");
    state.pendingIdleIntentsExisting(path);state.activateObservationExisting(path,{ownerId:"new",generation:1n});const j=createRuntimeIdleJournal(path,render);assert.equal(j.observationScopeVerified("new",1n,0n),false);assert.equal(selectIdleIntentIn(db,"T")!.detail,"preserve");assert.throws(()=>j.beforeMutation("new",1n,"T"),/requires review/);
  }finally{db.close();}
}));

// Explicit trusted-port tests isolate the synchronous publication boundary without
// adding a production lifecycle API or permitting replacement client authority.

for(const mutation of ['none','generation','client','closed','quarantined','restart','abort','validation','activation','final-admission'] as const)test(`native installation retains original scope and releases admissions: ${mutation}`,async()=>{
 const events:string[]=[],controller=new AbortController();let releases=0,installed=false,generation=1n,healthy=true,quarantined=false,restartPending=false;
 const client={identity:{},requireOwnedAdmission(){events.push('permit');}},other={identity:{},requireOwnedAdmission(){}};let live=client;let admissions=0;
 const server={instanceId:'original',generation:()=>generation,lifecycleSnapshot:()=>({generation,healthy,quarantined,restartPending}),admitResponse:(expected:bigint)=>{assert.equal(expected,generation);if(++admissions===2&&mutation==='final-admission')throw new Error('sealed');return {client:live,permit:{},release(){releases++;}};},installIdleReleaseJournal:()=>{events.push('install');installed=true;}};
 const idle={async validateInstallation(){events.push('validate');if(mutation==='validation')throw new Error('validation');}};
 const observation={async activate(scope:unknown){events.push('activate');assert.deepEqual(scope,{ownerId:'original',generation:1n});if(mutation==='activation')throw new Error('activation');if(mutation==='generation')generation=2n;if(mutation==='client')live=other;if(mutation==='closed')healthy=false;if(mutation==='quarantined')quarantined=true;if(mutation==='restart')restartPending=true;if(mutation==='abort')controller.abort(new Error('cancel'));}};
 const pending=installRuntimeIdleJournalNative(server as any,'/tmp/installation-captured.db',render,idle as any,observation as any,controller.signal);
 if(mutation==='none'){await pending;assert.equal(installed,true);assert.equal(releases,2);}else{await assert.rejects(pending);assert.equal(installed,false);assert.equal(releases,mutation==='client'?2:1);}
 assert.equal(events.indexOf('validate')<events.indexOf('activate')||mutation==='validation',true);if(mutation==='validation')assert.equal(events.includes('activate'),false);
});

for(const phase of ['validation','activation'] as const)test(`native installation real SQLite ${phase} lock permits timer progress after leaf entry`,async()=>storeFixture(async path=>{
 const db=await openInitialized(path),idle=new NativeIdleBeforeOwner(path,x=>x),observation=new NativeObservationLedgerOwner(path),trace=new SharedArrayBuffer(12),facade=new URL('../../src/store/state-access-facade.ts',import.meta.url);
 if(import.meta.url.endsWith('.js'))facade.pathname=facade.pathname.slice(0,-3)+'.js';
 const leaf=phase==='validation'?'pendingIdleIntentsExisting':'activateObservationExisting',worker=phase==='validation'?'native-idle-before-worker':'native-observation-ledger-worker';
 const restore=instrumentStoreWorker({match:worker+(import.meta.url.endsWith('.js')?'.js':'.ts'),trace,before:`const {StateAccessFacade:state}=await import(${JSON.stringify(facade.href)});const original=state.${leaf};state.${leaf}=(...args)=>{Atomics.store(trace,2,1);return Reflect.apply(original,state,args);};`});
 let pending:Promise<void>|undefined;
 try{
  db.exec('PRAGMA journal_mode=DELETE');db.exec(phase==='validation'?'BEGIN EXCLUSIVE':'BEGIN IMMEDIATE');
  pending=phase==='validation'?idle.validateInstallation():observation.activate({ownerId:'owner',generation:1n});let done=false;void pending.then(()=>{done=true;},()=>{done=true;});
  await waitTrace(trace,2);await new Promise(r=>setTimeout(r,80));assert.equal(Atomics.load(new Int32Array(trace),0),0);assert.equal(done,false);assert.equal(phase==='validation'?idle.busy:observation.busy,true);assert.equal(db.isTransaction,true);
  db.exec('ROLLBACK');await waitTrace(trace);assert.equal(done,false);releaseTrace(trace);restore();await pending;
 }finally{if(db.isTransaction)db.exec('ROLLBACK');releaseTrace(trace);restore();if(pending)await Promise.allSettled([pending]);await idle.close();await observation.close();db.close();}
}));

test('native installation captures relative journal path before the first await and retains old-owner rows',async()=>storeFixture(async path=>storeFixture(async other=>{
 const db=await openInitialized(path),originalCwd=process.cwd();let installed:ReturnType<typeof createRuntimeIdleJournal>|undefined,release!:()=>void;
 db.exec("INSERT INTO cdr_idle_release VALUES('old','old-owner',1,'T','V','job',1,'Unknown','keep')");
 const client={identity:{},requireOwnedAdmission(){}},server={instanceId:'original',generation:()=>1n,lifecycleSnapshot:()=>({generation:1n,healthy:true,quarantined:false,restartPending:false}),admitResponse:()=>({client,permit:{},release(){}}),installIdleReleaseJournal:(journal:ReturnType<typeof createRuntimeIdleJournal>)=>{installed=journal;}};
 const idle={validateInstallation:()=>new Promise<void>(resolve=>{release=resolve;})},observation={async activate(scope:unknown){assert.deepEqual(scope,{ownerId:'original',generation:1n});}};
 const pending=installRuntimeIdleJournalNative(server as any,relative(originalCwd,path),render,idle as any,observation as any);
 try{process.chdir(dirname(other));release();await pending;assert.ok(installed);assert.throws(()=>installed!.checkMutation('T'),/requires review/);assert.equal(selectIdleIntentIn(db,'T')!.detail,'keep');assert.equal(existsSync(other),false);}finally{process.chdir(originalCwd);release();await Promise.allSettled([pending]);db.close();}
})));
