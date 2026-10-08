import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {existsSync} from "node:fs";
import {PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
import {IdleObservationError} from "../../src/app-server/notification-state.ts";
import {createRuntimeIdleJournal,installRuntimeIdleJournal} from "../../src/runtime/idle-release-journal.ts";
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
  await f.owner.releaseIdleSubscription(f.current());assert.equal(f.current().state,"AwaitUnload");await f.owner.releaseIdleSubscription(f.current());assert.equal(f.current().state,"Settled");assert.equal(f.current().detail,"UnloadedConfirmed");
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
