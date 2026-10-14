import {requireDiscordText} from '../../discord/text.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {ControlTurnVerifier} from './control-turn.ts';
import {InvalidActionRequestError,MissingActionAppServerError,NoActionTargetError} from './errors.ts';
import {NativeRunnerInspectionReader,NativeRunnerInspectionUnavailable,RUNNER_INSPECTION_OUTPUT_BYTES} from './runner-inspection-native.ts';
/** Compatibility entry points route through the same bounded native profile.
 * Runtime command routing supplies one shared reader through RunnerInspection. */
export async function savedRequestMessage(path:string,channel:bigint,user:bigint,requestId:string,signal?:AbortSignal):Promise<string>{return new NativeRunnerInspectionReader(path).detail(channel,user,requestId,signal);}
export async function savedRequestSummary(path:string,channel:bigint,user:bigint,signal?:AbortSignal):Promise<string>{return new NativeRunnerInspectionReader(path).summary(channel,user,signal);}
export class RunnerInspection {
 readonly #reader:NativeRunnerInspectionReader;readonly #selection:ActionThreadSelection;readonly #control:ControlTurnVerifier;
 constructor(path:string,selection:ActionThreadSelection,control:ControlTurnVerifier,reader=new NativeRunnerInspectionReader(path)){requireDiscordText(path);NativeRunnerInspectionReader.prototype.assertPath.call(reader,path);this.#reader=reader;this.#selection=selection;this.#control=control;Object.freeze(this);}
 detail(channel:bigint,user:bigint,requestId:string,signal?:AbortSignal):Promise<string>{return NativeRunnerInspectionReader.prototype.detail.call(this.#reader,channel,user,requestId,signal);}
 async targetSummary(channel:bigint,signal?:AbortSignal):Promise<string>{
  signal?.throwIfAborted();let target:string,source:string;
  try{[target,source]=await this.#selection.target(channel);}catch(error){signal?.throwIfAborted();if(error instanceof NoActionTargetError)return `Current target lookup failed: ${error.message}. Global counts and your saved requests remain available; no target was substituted.`;throw error;}
  signal?.throwIfAborted();let owned:string;
  try{const [turn,generation]=await this.#control.control(channel,target);owned=`owned_active_turn: ${turn}\nconnection_generation: ${generation}`;}catch(error){if(!(error instanceof InvalidActionRequestError)&&!(error instanceof MissingActionAppServerError))throw error;owned=`owned_active_turn: unknown\nactive_check: ${error.message}`;}
  signal?.throwIfAborted();return NativeRunnerInspectionReader.prototype.targetCounts.call(this.#reader,target,source,owned,signal);
 }
 async runners(channel:bigint,user:bigint,signal?:AbortSignal):Promise<string>{
  const global=await NativeRunnerInspectionReader.prototype.global.call(this.#reader,signal),target=await this.targetSummary(channel,signal),summary=await NativeRunnerInspectionReader.prototype.summary.call(this.#reader,channel,user,signal);
  if(Buffer.byteLength(global)+Buffer.byteLength(target)+Buffer.byteLength(summary)+4>RUNNER_INSPECTION_OUTPUT_BYTES)throw new NativeRunnerInspectionUnavailable();return `${global}\n\n${target}\n\n${summary}`;
 }
}
Object.freeze(RunnerInspection.prototype);
