import test from 'node:test';import assert from 'node:assert/strict';
import {stabilizeAfterQueueRecovery,runtimeQueueRecoveryServer} from '../../src/runtime/queue-recovery-transport.ts';
import {ResidentStateError} from '../../src/app-server/resident-state.ts';
import {PortableResidentLifecycle} from '../../src/app-server/portable-resident-lifecycle.ts';
test('unquarantined snapshot masks restart, even when otherwise unhealthy',async()=>{
 let calls=0;assert.equal(await stabilizeAfterQueueRecovery({recoverySnapshot:async()=>({generation:7n,quarantined:false,healthy:false}),forceRecoveryRestart:async()=>{calls++;throw Error('masked');}}),false);assert.equal(calls,0);
});
test('quarantined recovery forces one restart and preserves explicit success',async()=>{
 let calls=0;assert.equal(await stabilizeAfterQueueRecovery({recoverySnapshot:async()=>({generation:7n,quarantined:true}),forceRecoveryRestart:async()=>{calls++;return true;}}),true);assert.equal(calls,1);
});
test('failed quiescence retains the originally observed generation',async()=>{
 const value={generation:7n,quarantined:true};
 await assert.rejects(stabilizeAfterQueueRecovery({recoverySnapshot:async()=>value,forceRecoveryRestart:async()=>{value.generation=8n;return false;}}),e=>e instanceof ResidentStateError&&e.detail.kind==='GenerationQuarantined'&&e.detail.generation===7n);
});
test('snapshot and restart failures propagate exact identities without retry',async()=>{
 const error={failure:true};let calls=0;
 await assert.rejects(stabilizeAfterQueueRecovery({recoverySnapshot:async()=>{throw error;},forceRecoveryRestart:async()=>{calls++;return true;}}),e=>e===error);assert.equal(calls,0);
 await assert.rejects(stabilizeAfterQueueRecovery({recoverySnapshot:async()=>({generation:1n,quarantined:true}),forceRecoveryRestart:async()=>{calls++;throw error;}}),e=>e===error);assert.equal(calls,1);
});
test('accessors and nonboolean successes cannot release recovered intake',async()=>{
 let reads=0;await assert.rejects(stabilizeAfterQueueRecovery({get recoverySnapshot(){reads++;return async()=>({generation:1n,quarantined:false});},forceRecoveryRestart:async()=>true}));assert.equal(reads,0);
 await assert.rejects(stabilizeAfterQueueRecovery({recoverySnapshot:async()=>({generation:1n,quarantined:true}),forceRecoveryRestart:async()=>1 as any}),TypeError);
 assert.throws(()=>runtimeQueueRecoveryServer({} as any));
});
test('actual healthy native owner keeps its child and generation after queue recovery',async()=>{
 const code="import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});";
 const owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'recovery-fixture',title:'fixture',version:'1'}},()=> 'safe',{persistDeadWork(){},oldChildExited(){}});
 try{const pid=owner.lifecycleSnapshot().processId;assert.equal(await stabilizeAfterQueueRecovery(runtimeQueueRecoveryServer(owner)),false);assert.equal(owner.lifecycleSnapshot().processId,pid);assert.equal(owner.generation(),1n);}finally{await owner.dispose();}
});
test('actual quarantined native owner remains held while admitted work lives, then reaps and replaces once',async()=>{
 const code="import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});";
 let exits=0;const owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'recovery-fixture',title:'fixture',version:'1'}},()=> 'safe',{persistDeadWork(){},oldChildExited(){exits++;}});
 const lease=owner.admitRequest(),pid=owner.lifecycleSnapshot().processId;
 try{
  owner.markTimeout(1n);
  await assert.rejects(stabilizeAfterQueueRecovery(runtimeQueueRecoveryServer(owner)),e=>e instanceof ResidentStateError&&e.detail.kind==='GenerationQuarantined');
  assert.equal(exits,0);assert.equal(owner.lifecycleSnapshot().processId,pid);
  lease.release();
  assert.equal(await stabilizeAfterQueueRecovery(runtimeQueueRecoveryServer(owner)),true);
  assert.equal(exits,1);assert.equal(owner.generation(),2n);assert.notEqual(owner.lifecycleSnapshot().processId,pid);
  assert.equal(await stabilizeAfterQueueRecovery(runtimeQueueRecoveryServer(owner)),false);assert.equal(exits,1);
 }finally{lease.release();await owner.dispose();}
});
