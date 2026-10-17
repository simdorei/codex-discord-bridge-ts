import test from 'node:test';import assert from 'node:assert/strict';import {OwnedWorkerSlot,ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';import {NativeIdleInventoryReader} from '../../src/runtime/completion/native-idle-inventory.ts';import {storeFixture} from '../helpers/store-fixture.ts';
const intent={intentId:'i',ownerId:'owner',generation:-1n,threadId:'a',turnId:'t',jobId:'j',revision:-1n,state:'Unknown',detail:''};
test('idle response boundary rejects over128, oversized wire, wrong target and malformed whole rows',async()=>storeFixture(async path=>{
 const run=OwnedWorkerSlot.prototype.runMaintenanceRead,reader=new NativeIdleInventoryReader(path);let getters=0;
 try{
  for(const value of [Array.from({length:129},()=>intent),[{...intent,generation:1n<<63n}],[{...intent,detail:'x'.repeat(16*1024*1024)}],[Object.defineProperty({...intent},'detail',{enumerable:true,get(){getters++;return '';}})]]){OwnedWorkerSlot.prototype.runMaintenanceRead=async()=>({ok:true,value});await assert.rejects(reader.pending());}
  OwnedWorkerSlot.prototype.runMaintenanceRead=async()=>({ok:true,value:intent});await assert.rejects(reader.get('b'),/unavailable/);assert.deepEqual(await reader.get('a'),intent);assert.equal(getters,0);assert.equal(ownedWorkerUsage().Maintenance,0);
 }finally{OwnedWorkerSlot.prototype.runMaintenanceRead=run;await reader.close();}
}));
