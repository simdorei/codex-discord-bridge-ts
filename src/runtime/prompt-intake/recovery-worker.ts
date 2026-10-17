import {AdmissionGate,DrainGateError} from "../../admission/drain-gate.ts";
import {DelayedTicks,type TickSource} from "../delayed-ticks.ts";
import type {PromptIntakeProcessor} from "./processor.ts";
export interface IntakeWorkerError {stage:"admission"|"recovery";error:unknown}
/** 30-second delayed recovery. Shutdown never abandons an in-flight cycle or releases
 * its admission permit early. Startup claim release requires separate singleton ownership. */
export async function runPromptIntakeRecoveryWorker(
  processor:Pick<PromptIntakeProcessor,"recoverPromptIntakes">,
  admission:Pick<AdmissionGate,"tryEnter">,
  shutdown:AbortSignal,
  options:{ticks?:()=>TickSource;onError?:(event:IntakeWorkerError)=>void}={},
):Promise<void>{
  if(shutdown.aborted)return;
  const ticks=(options.ticks??(()=>new DelayedTicks(30000)))(),report=options.onError??(()=>{});
  let wake!:()=>void;const stopped=new Promise<void>(resolve=>{wake=resolve;});shutdown.addEventListener("abort",wake,{once:true});
  try{
    while(!shutdown.aborted){
      await Promise.race([ticks.wait(),stopped]);if(shutdown.aborted)return;
      let permit;
      try{permit=admission.tryEnter();}catch(error){if(error instanceof DrainGateError&&error.kind==="Sealed")continue;report({stage:"admission",error});continue;}
      try{await processor.recoverPromptIntakes();}catch(error){report({stage:"recovery",error});}finally{permit.release();}
    }
  }finally{shutdown.removeEventListener("abort",wake);ticks.close();}
}
