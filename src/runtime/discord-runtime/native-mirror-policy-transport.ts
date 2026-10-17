import {OwnedWorkerSlot,OwnedWorkerBusyError,takeOwnedWorkerAdmissionRefusal} from '../owned-worker-slot.ts';
import type {NativeMirrorPolicyLimits} from './native-mirror-policy.ts';

// The original single Background slot, shared by every owner submission. No
// queue or second native-capacity budget is introduced by the extraction.
const slot=new OwnedWorkerSlot();
const refusals=new WeakMap<Promise<unknown>,unknown>();
type RefusalOrigin={eligible:boolean;error:unknown};

/** Consume only the exact outward transport Promise's one-use refusal proof.
 * A propagated genuine error from another invocation carries no such proof. */
export function takeNativeMirrorPolicyTransportRefusal(pending:Promise<unknown>|undefined,error:unknown):boolean{
 if(pending===undefined||!refusals.has(pending)||refusals.get(pending)!==error)return false;
 refusals.delete(pending);return true;
}

/** Internal fixed submission: path and scalar limits have already been captured
 * by the policy owner. The raw response is NOT a validated access policy. Keep
 * this wrapper non-async so the returned Promise is the exact proof-map key. */
export function submitNativeMirrorPolicy(path:string,limits:NativeMirrorPolicyLimits,signal?:AbortSignal):Promise<unknown>{
 const origin:RefusalOrigin={eligible:false,error:undefined};
 const pending=run(origin,path,limits,signal).catch((error:unknown)=>{
  if(origin.eligible&&origin.error===error)refusals.set(pending,error);
  throw error;
 });
 return pending;
}

async function run(origin:RefusalOrigin,path:string,limits:NativeMirrorPolicyLimits,signal?:AbortSignal):Promise<unknown>{
 if(slot.busy){const error=new OwnedWorkerBusyError();origin.eligible=true;origin.error=error;throw error;}
 let pending:Promise<unknown>|undefined,admitted=false,joined=Promise.resolve();
 try{
  try{pending=slot.run(new URL('./mirror-policy-worker.ts',import.meta.url),{path,maxRows:limits.maxRows,maxValueBytes:limits.maxValueBytes,maxOutputIds:limits.maxOutputIds,timeoutMs:limits.timeoutMs},limits.timeoutMs,signal);}
  finally{admitted=slot.busy;joined=slot.join();}
  return await pending;
 }catch(error){
  if(!admitted&&takeOwnedWorkerAdmissionRefusal(slot,pending,error)){origin.eligible=true;origin.error=error;}
  throw error;
 }finally{
  // Cleanup rejection keeps the original finally precedence and invalidates
  // proof even when cleanup happens to reject with the SAME refusal object.
  try{await joined;}catch(error){origin.eligible=false;throw error;}
 }
}
