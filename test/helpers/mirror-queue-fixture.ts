import assert from 'node:assert/strict';
import {QueueStartCoordinator} from '../../src/runtime/queue-runner/start-coordinator.ts';
/** Real queue/registry for isolated mirror tests; mirror polling must never call its backend. */
export function mirrorQueueFixture(path:string):QueueStartCoordinator{
 const unexpected=async():Promise<never>=>assert.fail('Mirror must not dispatch queue backend work');
 return new QueueStartCoordinator(path,{generation:()=>1n,residentInstanceId:()=>null,activeTurnId:unexpected,resumeThread:unexpected,readTurns:unexpected,startClaimedTurn:unexpected});
}
