import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import {interruptTurn} from "../../app-server/requests.ts";
import type {BridgeState} from "../bridge-state.ts";
import type {TargetLocks} from "../../core/keyed-locks.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import type {StoredIngress} from "../../store/ingress-read.ts";
import {snapshotStoredIngress} from "../../store/ingress-snapshot.ts";
import {cloneOwnedSerdeValue} from "../../core/owned-serde-value.ts";
import {snapshotSettingsBinding,validateSelectedSettingsSnapshot,validateLifecycleSettingsSnapshot} from "./settings-snapshot.ts";
import {ControlTurnVerifier} from "./control-turn.ts";
import {ActionIntegerRangeError,MissingActionAppServerError,storeActionCheck} from "./errors.ts";
import type {PromptActionResult} from "./prepared-submission.ts";
type Server=Pick<PortableResidentLifecycle,"instanceId"|"generation"|"lifecycleSnapshot"|"activeTurnId"|"execute">;
type Store=Pick<IStateAccessFacade,"acceptRunningStop"|"acceptUnresolvedStop"|"hasObservedCompletion"|"mirroredThreadId">;
export interface StopActionContext{readonly channelId:bigint;readonly userId:bigint}
function id(value:unknown):bigint{if(typeof value!=="bigint"||value<0n||value>=(1n<<63n))throw new ActionIntegerRangeError();return value;}
function immediate(text:string):PromptActionResult{return {text,waitsForFinal:false,ui:null};}
/** Already-admitted exact lifecycle binding only. Durable local intent is accepted
 * without waiting for target locks or looking up a server turn. A receipt is never
 * presented as proof that execution stopped. No raw-reference resolver is installed. */
export class StopActionExecutor{
  readonly #render:(error:unknown)=>string;readonly #path:string;readonly #server:Server|null;readonly #bridge:Pick<BridgeState,"selectedThreadId">;readonly #state:Store;readonly #verify:ControlTurnVerifier;
  constructor(path:string,server:Server|null,bridge:Pick<BridgeState,"selectedThreadId">,locks:TargetLocks,render:(error:unknown)=>string,state:Store=StateAccessFacade){this.#render=render;storeActionCheck(()=>{},render);this.#path=path;this.#server=server;this.#bridge=bridge;this.#state=state;this.#verify=new ControlTurnVerifier(path,server,bridge,locks,state);}
  async stopBound(input:StopActionContext,inputBinding:unknown,inputIngress:StoredIngress|null=null):Promise<PromptActionResult>{
    const context=cloneOwnedSerdeValue(input) as StopActionContext,binding=snapshotSettingsBinding(inputBinding),ingress=inputIngress===null?null:snapshotStoredIngress(inputIngress),scope={target:binding.target,channel:id(context.channelId),owner:id(context.userId)},check=storeActionCheck(()=>validateSelectedSettingsSnapshot(binding,this.#bridge),this.#render);
    const server=this.#server;
    if(server!==null){const receipt=this.#state.acceptRunningStop(this.#path,scope,binding,ingress,server.instanceId,id(server.generation()),check);if(receipt!==null)return immediate(`Stop accepted for ${binding.target}.\noperation_id: ${receipt.operation_id}\nExecution end is not confirmed; the original turn will be checked separately. Original requests will not be replayed automatically.`);}
    const receipt=this.#state.acceptUnresolvedStop(this.#path,scope,binding,ingress,check);if(receipt!==null)return immediate(`Stop accepted for ${binding.target}.\nOriginal local requests held (queued, preparing, running or unresolved): ${receipt.jobs.length}\nUnowned original requests held: ${receipt.ingresses?.length??0}\nExecution end is not confirmed; original requests will not be replayed automatically.`);
    if(server===null)throw new MissingActionAppServerError();const lease=await this.#verify.lock(binding.target);
    try{
      await validateLifecycleSettingsSnapshot(this.#path,binding,context.channelId,this.#bridge,this.#state);
      const [turn,generation]=binding.route==="Explicit"?await this.#verify.owned(binding.target):await this.#verify.control(context.channelId,binding.target);
      await server.execute(interruptTurn(binding.target,turn),generation);return immediate(`Stop request submitted for ${binding.target}.`);
    }finally{lease.release();}
  }
}
