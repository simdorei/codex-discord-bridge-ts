import {DelayedTicks,type TickSource} from "../delayed-ticks.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import type {PromptIntakeClaim} from "../../store/prompt-intake.ts";
import {snapshotPromptIntakeClaim} from "../../store/prompt-intake-write.ts";
import {SystemTimeError} from "../../store/queue-mark-running.ts";
export type ClaimResult<T>={ok:true;value:T}|{ok:false;error:unknown};
export type ClaimProcessingOutcome<T>={kind:"Finished";result:ClaimResult<T>}|{kind:"Lost"};
export interface RenewalTicks extends TickSource {}

type LeaseState=Pick<IStateAccessFacade,"renewPromptIntakeClaimIfCurrent"|"promptIntakeHasDurableOwner">;
/** Processing must not detach owned work: its Promise settles only when that work has ended.
 * Abort requests are not reclamation proof. On lease loss/error this runner joins processing
 * before returning, even if the processor ignores cancellation. Hard worker termination is separate. */
export class PromptClaimLeaseRunner{
  readonly #path:string;readonly #state:LeaseState;readonly #clock:()=>number;readonly #ticks:()=>RenewalTicks;
  constructor(path:string,state:LeaseState=StateAccessFacade,clock:()=>number=()=>Date.now()/1000,ticks:()=>RenewalTicks=()=>new DelayedTicks(120000)){
    this.#path=path;this.#state=state;this.#clock=clock;this.#ticks=ticks;
  }
  async #renew(claim:PromptIntakeClaim):Promise<PromptIntakeClaim|null>{
    const now=this.#clock();if(!Number.isFinite(now))throw new TypeError("Expected finite clock");if(now<0)throw new SystemTimeError(-now*1000);
    const current=await this.#state.renewPromptIntakeClaimIfCurrent(this.#path,claim,now,Math.max(now+600,claim.intake.claimExpiresAt+1));
    return current===null?null:snapshotPromptIntakeClaim(current);
  }
  async run<T>(input:PromptIntakeClaim,process:(claim:PromptIntakeClaim,signal:AbortSignal)=>Promise<T>):Promise<ClaimProcessingOutcome<T>>{
    const snapshot=snapshotPromptIntakeClaim(input);let current:PromptIntakeClaim|null;
    try{current=await this.#renew(snapshot);}catch(error){return {kind:"Finished",result:{ok:false,error}};}
    if(current===null)return {kind:"Lost"};
    const controller=new AbortController(),job=current.intake.jobId,ticks=this.#ticks(),processingClaim=snapshotPromptIntakeClaim(current);
    const processing:Promise<ClaimResult<T>>=Promise.resolve().then(()=>process(processingClaim,controller.signal)).then(value=>({ok:true,value}),error=>({ok:false,error}));
    const stop=async(error:unknown):Promise<void>=>{controller.abort(error);await processing;};
    try{
      while(true){
        let tickReady=false;const tick=ticks.wait().then(()=>{tickReady=true;});await Promise.race([tick,processing]);
        if(!tickReady)return {kind:"Finished",result:await processing};
        try{
          const renewed=await this.#renew(current);
          if(renewed!==null){current=renewed;continue;}
          if(await this.#state.promptIntakeHasDurableOwner(this.#path,job))return {kind:"Finished",result:await processing};
          await stop(new Error(`prompt intake claim lost: ${job}`));return {kind:"Lost"};
        }catch(error){await stop(error);return {kind:"Finished",result:{ok:false,error}};}
      }
    }finally{ticks.close();}
  }
}
