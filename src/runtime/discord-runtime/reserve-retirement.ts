import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {ReserveRetirement,ReserveRetirementLimits} from '../../store/reserve-retirement.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
export class RuntimeReserveRetirementError extends Error{
 constructor(detail:string){super('Runtime Reserve retirement failed: '+detail);this.name='RuntimeReserveRetirementError';}
}
export class RuntimeReserveRetirementUnconfirmed extends Error{
 readonly path:string;
 constructor(path:string,cause:unknown){super('Startup Reserve retirement outcome is unconfirmed; keep dispatch stopped and inspect the durable marker',{cause});this.name='RuntimeReserveRetirementUnconfirmed';this.path=path;}
}
const slot=new OwnedWorkerSlot('Control');
/** Run only under the caller's exclusive startup guard, after storage preparation
 * and before resident/recovery/dispatch. This fixed native owner performs the
 * empty-headless source branch. Abort/timeout retains the slot until native exit,
 * reports uncertainty, and never automatically retries or starts runtime work.
 * Initializer may have changed schema even when retirement itself rolls back. */
export async function retireRuntimeReserveOffThread(path:string,limits:ReserveRetirementLimits,timeoutMs=10000,signal?:AbortSignal):Promise<ReserveRetirement>{
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected startup abort signal');signal?.throwIfAborted();
 requireDiscordText(path);if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768)throw new RangeError('Invalid retirement path');const pinned=pinNativeRuntimePath(path);if(pinned.length>32768||Buffer.byteLength(pinned)>32768)throw new RangeError('Invalid retirement path');
 const maxRows=own(limits,'maxRows'),maxBytes=own(limits,'maxBytes');
 if(typeof maxRows!=='number'||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>4096||typeof maxBytes!=='number'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4194304)throw new RangeError('Invalid retirement resource limits');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new RangeError('Invalid retirement deadline');
 if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./reserve-retirement-worker.ts',import.meta.url),{path:pinned,limits:{maxRows,maxBytes}},timeoutMs,signal),joined=slot.join(),submitted=slot.busy;let response:unknown;
 try{try{response=await pending;}finally{await joined;}}catch(error){if(!submitted)throw error;throw new RuntimeReserveRetirementUnconfirmed(pinned,error);}
 if(signal?.aborted)throw new RuntimeReserveRetirementUnconfirmed(pinned,signal.reason);
 if(own(response,'ok')===true){
  const result=own(response,'result'),alreadyCompleted=own(result,'alreadyCompleted'),heldJobs=own(result,'heldJobs'),policySnapshots=own(result,'policySnapshots');
  if(typeof alreadyCompleted==='boolean'&&typeof heldJobs==='bigint'&&heldJobs>=0n&&heldJobs<=BigInt(maxRows)&&typeof policySnapshots==='bigint'&&policySnapshots>=0n&&policySnapshots<=BigInt(maxRows)&&(!alreadyCompleted||(heldJobs===0n&&policySnapshots===0n)))return Object.freeze({alreadyCompleted,heldJobs,policySnapshots});
 }else{
  const detail=own(response,'detail');if(typeof detail==='string'&&own(response,'uncertain')===false)throw new RuntimeReserveRetirementError(detail);
 }
 throw new RuntimeReserveRetirementUnconfirmed(pinned,response);
}
