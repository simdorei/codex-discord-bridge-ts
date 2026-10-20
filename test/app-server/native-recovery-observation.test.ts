import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {DatabaseSync} from "node:sqlite";
import {NativeRecoveryObservation,PortableResidentLifecycle} from "../../src/app-server/portable-resident-lifecycle.ts";
async function owner(t:TestContext,mode="normal"){
  const script=`import readline from 'node:readline';const mode=${JSON.stringify(mode)};const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),reply=x=>emit({id:m.id,result:x});if(m.method==='initialize')reply({});else if(m.method==='thread/read'){if(mode==='hang'){emit({method:'fixture/read-seen'});return;}reply({thread:{id:m.params.threadId,status:{type:'idle'}}});}else if(m.method==='thread/turns/list')reply({data:mode==='missing'?[]:[{id:'V',status:'completed'}],nextCursor:null});else if(m.method==='thread/goal/get')reply({goal:null});});`;
  const o=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",script],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},()=>"diagnostic",{persistDeadWork(){},oldChildExited(){}},t.signal,{renderError:e=>e instanceof Error?e.message:"unknown",fence:{requestOrigin:()=>null,checkRequest(){},beginMutationWithOrigin(){throw new Error("Read cannot create mutation claim");},finishMutation(){throw new Error("Read cannot finish mutation claim");}}});t.after(()=>o.dispose());return o;
}
test("native recovery proof holds actual admission and consumes once around a pre-acquired final commit",{timeout:15000},async t=>{
  const o=await owner(t),proof=await o.observeRecoveryPrerequisites("T",["V"],500);try{assert.equal(proof.threadId(),"T");assert.equal(proof.residentId(),o.instanceId);assert.equal(proof.generation(),1n);assert.equal((proof.observation() as any).required_owners_complete,true);proof.checkCurrent();assert.equal(JSON.stringify(proof),"{}");
    const db=new DatabaseSync(":memory:");try{db.exec("CREATE TABLE committed(value); BEGIN IMMEDIATE; INSERT INTO committed VALUES(1)");proof.withCurrentConnection(()=>db.exec("COMMIT"));assert.equal(db.isTransaction,false);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM committed").get()!.n,1);}finally{db.close();}
    assert.throws(()=>proof.withCurrentConnection(()=>{}),/consumed/);const a=o.admitRequest();assert.equal(a.client.admissionSnapshot().inFlight,1n);a.release();
  }finally{proof.dispose();}
});
test("pending restart invalidates a captured native proof and its failed consume releases ownership",{timeout:15000},async t=>{
  const o=await owner(t),proof=await o.observeRecoveryPrerequisites("T",["V"],500);let published=0;o.requestRestart();assert.throws(()=>proof.withCurrentConnection(()=>{published++;}),/no longer current and open/);assert.equal(published,0);assert.equal(await o.restartIfQuiescent(t.signal),true);assert.equal(o.generation(),2n);
});
test("opaque native observation cannot be fabricated from JSON or a copied prototype",()=>{
  assert.throws(()=>new NativeRecoveryObservation(Symbol("owned native recovery observation"),{} as any,{}),/owning resident/);const forged=Object.create(NativeRecoveryObservation.prototype);let calls=0;assert.throws(()=>forged.withCurrentConnection(()=>{calls++;}),TypeError);assert.equal(calls,0);
});
test("invalid owners, duplicates and UTF-8 byte limits fail without leaking native admission",{timeout:15000},async t=>{
  const o=await owner(t);for(const [thread,owners,limit]of [["",["V"],500],["T",[],500],["T",["V","V"],500],["T",["😀".repeat(129)],500],["T",["V"],0]] as const)await assert.rejects(o.observeRecoveryPrerequisites(thread,owners,limit),/bounded exact target/);const a=o.admitRequest();assert.equal(a.client.admissionSnapshot().inFlight,1n);a.release();
});
test("missing bounded history releases all native read leases without issuing a recovery proof",{timeout:15000},async t=>{
  const o=await owner(t,"missing");await assert.rejects(o.observeRecoveryPrerequisites("T",["V"],500),/absent from bounded history/);const a=o.admitRequest();assert.equal(a.client.admissionSnapshot().inFlight,1n);a.release();
});
test("caller cancellation joins bounded observational reads and releases the collector lifetime",{timeout:15000},async t=>{
  const o=await owner(t,"hang"),events=o.subscribeNotifications(),abort=new AbortController(),reason={cancelled:true};try{const pending=o.observeRecoveryPrerequisites("T",["V"],2000,abort.signal),rejected=assert.rejects(pending,e=>e===reason);await events.receive(t.signal);abort.abort(reason);await rejected;const a=o.admitRequest();assert.equal(a.client.admissionSnapshot().inFlight,1n);a.release();assert.equal(o.lifecycleSnapshot().quarantined,false);}finally{events.dispose();}
});
test("async publication is refused without invocation and consumes the proof once",{timeout:15000},async t=>{
  const o=await owner(t),proof=await o.observeRecoveryPrerequisites("T",["V"],500);let called=0;assert.throws(()=>proof.withCurrentConnection(async()=>{called++;}),/synchronous/);assert.equal(called,0);assert.throws(()=>proof.checkCurrent(),/consumed/);const a=o.admitRequest();assert.equal(a.client.admissionSnapshot().inFlight,1n);a.release();
});
test("native observation expires after its original ten-second budget even if collection was fast",{timeout:20000},async t=>{
  const o=await owner(t),proof=await o.observeRecoveryPrerequisites("T",["V"],500);await delay(10_020,undefined,{signal:t.signal});let published=0;assert.throws(()=>proof.withCurrentConnection(()=>{published++;}),/recovery\/read-only-observation timed out after 10000/);assert.equal(published,0);const a=o.admitRequest();assert.equal(a.client.admissionSnapshot().inFlight,1n);a.release();
});
test("native proof methods cannot be shadowed to bypass consumed lifetime checks",{timeout:15000},async t=>{
  const o=await owner(t),proof=await o.observeRecoveryPrerequisites("T",["V"],500);try{proof.dispose();let called=0;assert.throws(()=>Object.defineProperty(proof,"withCurrentConnection",{value:()=>{called++;}}),TypeError);assert.ok(Object.isFrozen(NativeRecoveryObservation.prototype));assert.throws(()=>proof.withCurrentConnection(()=>{called++;}),/consumed/);assert.equal(called,0);}finally{proof.dispose();}
});
