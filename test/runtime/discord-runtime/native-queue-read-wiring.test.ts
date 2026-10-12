import test from 'node:test';
import assert from 'node:assert/strict';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {startRuntimeResident} from '../../../src/runtime/discord-runtime/resident-startup.ts';
import {buildRecoveredRuntimeQueue} from '../../../src/runtime/discord-runtime/queue-bootstrap.ts';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
const code="import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});";
test('real runtime bootstrap injects native reads into recovered coordinator and leaves no worker after return',async()=>storeFixture(async path=>{
 const render=()=> 'safe',owner=await startRuntimeResident({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'native-queue-test',title:'fixture',version:'1'}},path,'runtime',null,render);
 const run=OwnedWorkerSlot.prototype.run,seen:string[]=[];
 OwnedWorkerSlot.prototype.run=function(url,data,timeout,signal){if(/native-read-state-worker\.(ts|js)$/.test(url.pathname)){assert.equal((data as {path:string}).path,path);seen.push((data as {operation:string}).operation);}return run.call(this,url,data,timeout,signal);};
 try{const recovered=await buildRecoveredRuntimeQueue(path,owner,new AdmissionGate(),render,()=>{},()=>{});assert.ok(seen.length>=2);assert.ok(seen.every(op=>op==='List'||op==='Eligible'));assert.notEqual(recovered.queue.reads.state.listFiltered,state.listFiltered);assert.notEqual(recovered.queue.reads.state.eligibleJobs,state.eligibleJobs);seen.length=0;
 await recovered.queue.reads.state.listFiltered(path,null,null);await recovered.queue.reads.state.eligibleJobs(path,[]);assert.deepEqual(seen,['List','Eligible']);assert.equal(ownedWorkerUsage().Control,0);assert.equal(recovered.recovery.started,0);assert.equal(owner.lifecycleSnapshot().healthy,true);
 }finally{OwnedWorkerSlot.prototype.run=run;await owner.dispose();}
}));
