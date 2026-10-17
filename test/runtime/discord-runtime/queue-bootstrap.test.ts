import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {startRuntimeResident} from '../../../src/runtime/discord-runtime/resident-startup.ts';
import {buildRecoveredRuntimeQueue} from '../../../src/runtime/discord-runtime/queue-bootstrap.ts';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {reviewedRecoveryPolicyInstalledIn} from '../../../src/store/reviewed-recovery-policy.ts';
import {REVIEWED_INCIDENT_THREAD,asyncRecoveryPolicyHeldIn} from '../../../src/store/async-resolution-policy.ts';
const render=(e:unknown)=>e instanceof Error?e.message:'safe';
const code="import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});";
async function fixture(run:(path:string,owner:Awaited<ReturnType<typeof startRuntimeResident>>)=>Promise<void>){await storeFixture(async path=>{
 const owner=await startRuntimeResident({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'bootstrap-test',title:'fixture',version:'1'}},path,'runtime',null,render);
 try{await run(path,owner);}finally{await owner.dispose();}
});}
test('native queue bootstrap installs policy and recovers empty exact-ID queue without child replacement',async()=>fixture(async(path,owner)=>{
 const pid=owner.lifecycleSnapshot().processId;let notices=0,wakes=0;
 const result=await buildRecoveredRuntimeQueue(path,owner,new AdmissionGate(),render,()=>{notices++;},()=>{wakes++;});
 assert.equal(result.restarted,false);assert.equal(result.backend.requiresAppServerFork(),false);assert.equal(result.queue.requiresAppServerFork(),false);assert.equal(result.recovery.started,0);assert.equal(result.queue.dbPath,path);assert.equal(owner.lifecycleSnapshot().processId,pid);assert.equal(notices,0);
 result.queue.notifyDeliveryReady();assert.equal(wakes,1);
 const db=await openInitialized(path);try{assert.equal(reviewedRecoveryPolicyInstalledIn(db),true);}finally{db.close();}
}));
test('policy installation failure is reported once while original incident fallback remains held',async()=>fixture(async(path,owner)=>{
 const db=await openInitialized(path);try{db.exec("CREATE TRIGGER policy_denied BEFORE INSERT ON cdr_async_recovery_policies BEGIN SELECT RAISE(ABORT,'policy fixture denied'); END");}finally{db.close();}
 const reports:unknown[][]=[];const result=await buildRecoveredRuntimeQueue(path,owner,new AdmissionGate(),render,(...args)=>{reports.push(args);},()=>{});
 assert.equal(result.recovery.started,0);assert.equal(reports.length,1);assert.equal(reports[0]![0],REVIEWED_INCIDENT_THREAD);assert.match(String(reports[0]![1]),/policy fixture denied/);
 const check=await openInitialized(path);try{assert.equal(reviewedRecoveryPolicyInstalledIn(check),false);assert.equal(asyncRecoveryPolicyHeldIn(check,REVIEWED_INCIDENT_THREAD),true);assert.equal(asyncRecoveryPolicyHeldIn(check,'unrelated'),false);}finally{check.close();}
}));
test('quarantined empty native generation is replaced before returning recovered queue',async()=>fixture(async(path,owner)=>{
 owner.markTimeout(1n);const pid=owner.lifecycleSnapshot().processId;const result=await buildRecoveredRuntimeQueue(path,owner,new AdmissionGate(),render,()=>{},()=>{});
 assert.equal(result.restarted,true);assert.equal(owner.generation(),2n);assert.notEqual(owner.lifecycleSnapshot().processId,pid);
}));
test('unexpected reporting failure is propagated and server remains caller-owned for cleanup',async()=>fixture(async(path,owner)=>{
 const db=await openInitialized(path);try{db.exec("CREATE TRIGGER policy_denied BEFORE INSERT ON cdr_async_recovery_policies BEGIN SELECT RAISE(ABORT,'denied'); END");}finally{db.close();}
 const sentinel={report:true};await assert.rejects(buildRecoveredRuntimeQueue(path,owner,new AdmissionGate(),render,()=>{throw sentinel;},()=>{}),e=>e===sentinel);assert.equal(owner.lifecycleSnapshot().healthy,true);
}));
test('forged runtime owner is rejected before database creation',async()=>storeFixture(async path=>{
 await assert.rejects(buildRecoveredRuntimeQueue(path,{} as any,new AdmissionGate(),render,()=>{},()=>{}),TypeError);assert.equal(existsSync(path),false);
}));

test('queue recovery failure does not publish a coordinator or close a caller-owned native server',async()=>fixture(async(path,owner)=>{
 const db=await openInitialized(path);try{db.exec("CREATE TABLE IF NOT EXISTS codex_exact_thread_routing(enabled INTEGER NOT NULL); DELETE FROM codex_exact_thread_routing; CREATE TRIGGER recovery_denied BEFORE INSERT ON codex_exact_thread_routing BEGIN SELECT RAISE(ABORT,'recovery fixture denied'); END");}finally{db.close();}
 let policyReports=0;await assert.rejects(buildRecoveredRuntimeQueue(path,owner,new AdmissionGate(),render,()=>{policyReports++;},()=>{}),/recovery fixture denied/);
 assert.equal(policyReports,0);assert.equal(owner.lifecycleSnapshot().healthy,true);assert.equal(owner.generation(),1n);
}));
