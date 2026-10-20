import {it} from 'node:test';
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {storeFixture} from '../helpers/store-fixture.ts';
import {NativeBridgeStateOwner} from '../../src/runtime/bridge-state-native.ts';
import {captureSelectedSettingsCheck} from '../../src/runtime/action-executor/settings-snapshot.ts';
import {storeActionCheck} from '../../src/runtime/action-executor/errors.ts';
import {StopControlWorker} from '../../src/runtime/action-executor/stop-worker.ts';
import {TargetLocks} from '../../src/core/keyed-locks.ts';
import {StoreIntegrityError} from '../../src/store/schema-assembly.ts';
import type {StopControl,StopClaim} from '../../src/store/stop-control-dispatch.ts';
const render=(e:unknown)=>e instanceof Error?e.message:'opaque';
it('native prepared final check remains synchronous and invalidates on same-owner settings write',()=>storeFixture(async root=>{
 const owner=new NativeBridgeStateOwner(join(dirname(root),'bridge.json'));await owner.execute({kind:'Select',id:'T'});
 const check=storeActionCheck(await captureSelectedSettingsCheck({target:'T',route:'Selected',command:{Stop:{reference:null}}},owner),render);
 assert.equal(check(),undefined);await owner.execute({kind:'Remember',id:'other',model:'model',reasoning:null,speed:null});
 assert.throws(check,StoreIntegrityError);assert.equal(await owner.execute({kind:'Selected'}),'T');
}));
it('explicit and mapped final checks perform no selected file read',()=>storeFixture(async root=>{
 const owner=new NativeBridgeStateOwner(join(root,'impossible-child','bridge.json'));
 for(const route of ['Explicit','Mapped'] as const){const check=await captureSelectedSettingsCheck({target:'T',route,command:{Stop:{reference:'T'}}},owner);assert.equal(check(),undefined);}
}));
it('real owner mutation during Stop verification rejects original claim with no RPC or lock leak',()=>storeFixture(async root=>{
 const owner=new NativeBridgeStateOwner(join(dirname(root),'bridge.json'));await owner.execute({kind:'Select',id:'T'});
 const resident='00000000-0000-4000-8000-000000000001' as const,locks=new TargetLocks();let claims=0,wires=0;
 const control:StopControl={operation_id:'stop',target:'T',channel:42n,owner:3n,resident,generation:1n,turn:'V',binding:{target:'T',route:'Selected',command:{Stop:{reference:null}}},jobs:[],can_settle:true};
 const server={instanceId:resident,generation:()=>1n,lifecycleSnapshot:()=>({generation:1n,healthy:true,quarantined:false,restartPending:false,processId:1}),activeTurnId:()=> 'V',executeStopControl:async()=>{wires++;return {};}};
 const store={pendingStopControlsAfter:()=>[[1n,control] as const],claimStopControl:(_p:string,_c:unknown,check:()=>void):StopClaim|null=>{check();claims++;return null;},recordStopControlError(){},hasObservedCompletion:async()=>{await owner.execute({kind:'Select',id:'other'});return false;},mirroredThreadId:async()=>null};
 const worker=new StopControlWorker('fixture',server,{selectedThreadId(){assert.fail('synchronous Bridge read');}},locks,render,()=>{},store,owner);
 await assert.rejects(worker.process(),StoreIntegrityError);assert.equal(claims,0);assert.equal(wires,0);assert.equal(locks.activeTargetCount,0);assert.equal(await owner.execute({kind:'Selected'}),'other');
}));
it('unchanged native selected snapshot reaches original synchronous Stop claim once',()=>storeFixture(async root=>{
 const owner=new NativeBridgeStateOwner(join(dirname(root),'bridge.json'));await owner.execute({kind:'Select',id:'T'});
 const resident='00000000-0000-4000-8000-000000000001' as const,locks=new TargetLocks();let claims=0;
 const control:StopControl={operation_id:'stop',target:'T',channel:42n,owner:3n,resident,generation:1n,turn:'V',binding:{target:'T',route:'Selected',command:{Stop:{reference:null}}},jobs:[],can_settle:true};
 const server={instanceId:resident,generation:()=>1n,lifecycleSnapshot:()=>({generation:1n,healthy:true,quarantined:false,restartPending:false,processId:1}),activeTurnId:()=> 'V',executeStopControl:async()=>{assert.fail('null claim cannot dispatch');}};
 const store={pendingStopControlsAfter:()=>[[1n,control] as const],claimStopControl:(_p:string,_c:unknown,check:()=>void):StopClaim|null=>{assert.equal(check(),undefined);claims++;return null;},recordStopControlError(){},hasObservedCompletion:async()=>false,mirroredThreadId:async()=>null};
 const worker=new StopControlWorker('fixture',server,{selectedThreadId(){assert.fail('synchronous Bridge read');}},locks,render,()=>{},store,owner);
 assert.equal(await worker.process(),0);assert.equal(claims,1);assert.equal(locks.activeTargetCount,0);
}));
