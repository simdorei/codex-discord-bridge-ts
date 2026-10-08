import assert from "node:assert/strict";
import {test} from "node:test";
import {CompletionSourceIntake} from "../../src/runtime/completion/source-intake.ts";
import {CompletionEventBudget} from "../../src/runtime/completion/scheduler/envelope.ts";
import {TerminalFence} from "../../src/runtime/completion/terminal-fence.ts";
import {BoundedBroadcast} from "../../src/app-server/broadcast.ts";
import type {ResidentNotificationEvent} from "../../src/app-server/resident-forwarders.ts";
test("every successful source page yields an event-loop turn even when all store awaits settle immediately",async()=>{
 const owner='00000000-0000-4000-8000-000000000001' as const,broadcast=new BoundedBroadcast<ResidentNotificationEvent>(1);
 const server={instanceId:owner,generation:()=>1n,observationWindow:()=>({ownerId:owner,generation:1n,firstAvailable:1n,sourceUpper:0n,upper:0n,scannedThrough:0n,events:[]}),markSourceObservationGap(){},markIdleObservationGap(){},subscribeNotifications:()=>broadcast.subscribe()};
 const store={activateObservation:async()=>{},discoverObservation:async()=>{}},intake=new CompletionSourceIntake('unused',server,new TerminalFence(),false,()=>{},new CompletionEventBudget(),store);let reached=false;
 const immediate=setImmediate(()=>{reached=true;});try{await intake.scanOnce();assert.equal(reached,true);}finally{clearImmediate(immediate);intake.close();broadcast.close();}
});
