import {withStopOrigin} from '../../app-server/dispatch-origin.ts';
import {stopOriginForIngress} from '../../store/stop-revision-read.ts';
import {BridgeState} from '../bridge-state.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {loadLifecycleAdmission,type LifecycleActor} from './lifecycle-admission.ts';
import {validateLifecycleSettingsSnapshot} from './settings-snapshot.ts';
import {StopActionExecutor} from './stop-action.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
/** Admitted message wrapper. Local durable stop receipt is not execution-end
 * evidence. Never invents a missing lifecycle target or fresh stop revision. */
export class AdmittedStopExecutor {
 readonly #path:string;readonly #bridge:BridgeState;readonly #stop:StopActionExecutor;
 constructor(path:string,bridge:BridgeState,stop:StopActionExecutor){requireDiscordText(path);this.#path=path;this.#bridge=bridge;this.#stop=stop;Object.freeze(this);}
 async execute(input:LifecycleActor,reference:string|null,key:string,signal?:AbortSignal):Promise<ActionResult>{
  const {actor,record,binding}=await loadLifecycleAdmission(this.#path,input,'Stop',reference,key,signal);await validateLifecycleSettingsSnapshot(this.#path,binding,actor.channelId,this.#bridge);signal?.throwIfAborted();
  return withStopOrigin(stopOriginForIngress(record)??null,async()=>snapshotActionResult(await StopActionExecutor.prototype.stopBound.call(this.#stop,actor,binding,record,signal)));
 }
}
Object.freeze(AdmittedStopExecutor.prototype);
