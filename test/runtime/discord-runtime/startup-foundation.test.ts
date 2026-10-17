import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync,readFileSync} from 'node:fs';import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {admitIngress} from '../../../src/store/ingress-admission.ts';
import {startRuntimeFoundation} from '../../../src/runtime/discord-runtime/startup-foundation.ts';import {RuntimeStoragePreparationError} from '../../../src/runtime/discord-runtime/storage-preparation.ts';import {RuntimeReserveRetirementError} from '../../../src/runtime/discord-runtime/reserve-retirement.ts';import {recoverRuntimeIngressOffThread,RuntimeIngressRecoveryError,RuntimeIngressRecoveryUnconfirmed} from '../../../src/runtime/discord-runtime/native-ingress-recovery.ts';import {ownedWorkerUsage,OwnedWorkerSlot,OwnedWorkerBudgetError} from '../../../src/runtime/owned-worker-slot.ts';
const limits={maxRows:128,maxBytes:1048576},render=(e:unknown)=>e instanceof Error?e.message:'opaque';
const script="import fs from 'node:fs';import readline from 'node:readline';import{DatabaseSync}from'node:sqlite';fs.writeFileSync(process.env.PID_FILE,String(process.pid));readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined){if(m.method==='initialize'){const db=new DatabaseSync(process.env.BRIDGE_DB);try{fs.writeFileSync(process.env.OBSERVED,JSON.stringify({marker:db.prepare('SELECT COUNT(*) AS n FROM cdr_store_retirements').get().n,mode:db.prepare('SELECT mode FROM codex_reserve_policy').get()?.mode,states:db.prepare('SELECT state FROM discord_ingress_journal ORDER BY ingress_id').all()}));if(process.env.FAIL_RECOVERY==='1')db.exec(\"CREATE TRIGGER reject_startup_ack BEFORE UPDATE OF ack_recovery_allowed ON codex_new_first_replies BEGIN SELECT RAISE(ABORT,'recovery failed after child spawn');END\");}finally{db.close();}}process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');}});";
function config(path:string,fail=false){return {process:{executable:process.execPath,arguments:['--input-type=module','-e',script],environment:{PID_FILE:join(dirname(path),'child.pid'),BRIDGE_DB:path,OBSERVED:join(dirname(path),'observed.json'),FAIL_RECOVERY:fail?'1':'0'}},clientInfo:{name:'foundation-fixture',title:'fixture',version:'1'}};}
function stateFile(path:string){const stateDb=join(dirname(path),'codex.sqlite'),db=new DatabaseSync(stateDb);db.exec('CREATE TABLE preserved(value)');db.close();return stateDb;}
async function ingress(path:string,id='prior'){await admitIngress(path,{ingressId:id,kind:'message',eventId:id==='prior'?1n:2n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n},targetThreadId:'thread',canonicalOwner:null,now:1});}
async function edit(path:string,sql:string){const db=await openInitialized(path);try{db.exec(sql);}finally{db.close();}}
function observed(path:string){return JSON.parse(readFileSync(join(dirname(path),'observed.json'),'utf8'));}
test('foundation commits manual retirement before actual child initialization and returns only after ingress recovery',async()=>storeFixture(async mirrorDb=>{
 const stateDb=stateFile(mirrorDb);await ingress(mirrorDb);await edit(mirrorDb,"INSERT INTO codex_reserve_policy(thread_id,mode,state)VALUES('thread','auto','unknown')");
 const result=await startRuntimeFoundation({stateDb,mirrorDb},config(mirrorDb),'current',null,render,limits);
 try{assert.equal(result.retirement.alreadyCompleted,false);assert.equal(result.retirement.policySnapshots,1n);assert.equal(result.heldIngress,0);assert.deepEqual(observed(mirrorDb),{marker:1,mode:'manual',states:[{state:'held'}]});assert.equal(result.owner.lifecycleSnapshot().healthy,true);assert.equal(result.owner.observationTrackingEnabled(),true);}finally{await result.owner.dispose();}
 assert.equal(result.owner.lifecycleSnapshot().processId,null);assert.equal(ownedWorkerUsage().Control,0);
}));
test('completed retirement marker does not skip later prior-runtime ingress recovery after child starts',async()=>storeFixture(async mirrorDb=>{
 const stateDb=stateFile(mirrorDb);await ingress(mirrorDb);await edit(mirrorDb,"INSERT INTO cdr_store_retirements VALUES('manual-reserve-v1','{}',1)");
 const result=await startRuntimeFoundation({stateDb,mirrorDb},config(mirrorDb),'current',null,render,limits);
 try{assert.equal(result.retirement.alreadyCompleted,true);assert.equal(result.heldIngress,1);assert.equal(observed(mirrorDb).states[0].state,'staged');const db=new DatabaseSync(mirrorDb,{readOnly:true});try{assert.equal(db.prepare('SELECT state FROM discord_ingress_journal').get()!.state,'held');}finally{db.close();}}finally{await result.owner.dispose();}
}));
test('failed retirement prevents child launch and rolls back automatic mode changes',async()=>storeFixture(async mirrorDb=>{
 const stateDb=stateFile(mirrorDb);await edit(mirrorDb,"INSERT INTO codex_reserve_policy(thread_id,mode,state)VALUES('thread','auto','unknown');CREATE TRIGGER reject_marker BEFORE INSERT ON cdr_store_retirements BEGIN SELECT RAISE(ABORT,'reject marker');END");
 await assert.rejects(startRuntimeFoundation({stateDb,mirrorDb},config(mirrorDb),'current',null,render,limits),RuntimeReserveRetirementError);assert.equal(existsSync(join(dirname(mirrorDb),'child.pid')),false);const db=new DatabaseSync(mirrorDb,{readOnly:true});try{assert.equal(db.prepare('SELECT mode FROM codex_reserve_policy').get()!.mode,'auto');}finally{db.close();}
}));
test('post-spawn recovery failure reaps exact native child before rejection and keeps original request ownership',async()=>storeFixture(async mirrorDb=>{
 const stateDb=stateFile(mirrorDb);await ingress(mirrorDb);await edit(mirrorDb,"UPDATE discord_ingress_journal SET state='owned',owner_id='job';INSERT INTO codex_new_first_replies(job_id,ingress_id,identity_json)VALUES('job','prior','{}')");
 await assert.rejects(startRuntimeFoundation({stateDb,mirrorDb},config(mirrorDb,true),'current',null,render,limits),e=>e instanceof RuntimeIngressRecoveryError&&e.message.includes('recovery failed after child spawn'));
 const pid=Number(readFileSync(join(dirname(mirrorDb),'child.pid'),'utf8'));assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH');const db=new DatabaseSync(mirrorDb,{readOnly:true});try{assert.equal(db.prepare('SELECT owner_id FROM discord_ingress_journal').get()!.owner_id,'job');assert.equal(db.prepare('SELECT ack_recovery_allowed FROM codex_new_first_replies').get()!.ack_recovery_allowed,0);}finally{db.close();}
}));
test('foundation pins path/configuration before awaits and never follows a caller replacement',async()=>storeFixture(async mirrorDb=>{
 const paths={stateDb:stateFile(mirrorDb),mirrorDb},c=config(mirrorDb),foreign=join(dirname(mirrorDb),'foreign.sqlite');const pending=startRuntimeFoundation(paths,c,'current',null,render,limits);paths.mirrorDb=foreign;c.process.arguments[2]='throw Error("replaced")';
 const result=await pending;try{assert.equal(existsSync(foreign),false);assert.equal(result.owner.lifecycleSnapshot().healthy,true);}finally{await result.owner.dispose();}
}));
test('missing Codex state and preflight invalid input never launch child',async()=>storeFixture(async mirrorDb=>{
 const paths={stateDb:mirrorDb+'.missing',mirrorDb};await assert.rejects(startRuntimeFoundation(paths,config(mirrorDb),'current',null,render,limits),RuntimeStoragePreparationError);assert.equal(existsSync(mirrorDb),false);
 for(const input of [{maxRows:0,maxBytes:1},{maxRows:1,maxBytes:NaN}])await assert.rejects(startRuntimeFoundation(paths,config(mirrorDb),'current',null,render,input),RangeError);
 const a=new AbortController();a.abort('pre');await assert.rejects(startRuntimeFoundation(paths,config(mirrorDb),'current',null,render,limits,10000,a.signal),e=>e==='pre');assert.equal(existsSync(join(dirname(mirrorDb),'child.pid')),false);
}));
test('native ingress deadline retains unknown commit outcome and joins before releasing Control',async()=>storeFixture(async path=>{
 await ingress(path);await assert.rejects(recoverRuntimeIngressOffThread(path,'current',20,limits,1),RuntimeIngressRecoveryUnconfirmed);assert.equal(ownedWorkerUsage().Control,0);const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare('SELECT state FROM discord_ingress_journal').get()!.state,'held');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_outbox').get()!.n,1);}finally{db.close();}
}));

test('native recovery budget failure reports failure without partial notices or flags',async()=>storeFixture(async path=>{
 await ingress(path);await assert.rejects(recoverRuntimeIngressOffThread(path,'current',20,{...limits,maxBytes:1}),RuntimeIngressRecoveryError);const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare('SELECT state FROM discord_ingress_journal').get()!.state,'staged');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_outbox').get()!.n,0);}finally{db.close();}
}));
test('native ingress preabort and occupied Control slot cannot create a store',async()=>storeFixture(async path=>{
 const a=new AbortController();a.abort('pre');await assert.rejects(recoverRuntimeIngressOffThread(path,'current',20,limits,10000,a.signal),e=>e==='pre');
 const slot=new OwnedWorkerSlot('Control'),shared=new SharedArrayBuffer(4),v=new Int32Array(shared);const pending=slot.run(new URL('data:text/javascript,'+encodeURIComponent("import{parentPort,workerData}from'node:worker_threads';Atomics.wait(new Int32Array(workerData),0,0,10000);parentPort.postMessage('done');parentPort.close();")),shared,10000);
 try{await assert.rejects(recoverRuntimeIngressOffThread(path,'current',20,limits),OwnedWorkerBudgetError);assert.equal(existsSync(path),false);}finally{Atomics.store(v,0,1);Atomics.notify(v,0);await pending;await slot.join();}
}));
