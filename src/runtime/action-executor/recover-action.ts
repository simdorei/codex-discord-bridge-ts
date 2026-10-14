import {posix,win32} from 'node:path';
import {NativeRecoveryOwner,type OriginalRecoveryInput} from '../writer-recovery/native-owner.ts';
import {handoffRecovery,type RecoveryController} from '../writer-recovery/handoff.ts';
import {pinNativeRuntimePath,type PathPlatform} from '../runtime-paths/path-text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {types} from 'node:util';
import {requireDiscordText} from '../../discord/text.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
import {ActionExecutionError} from './action-error.ts';
/** Explicit startup dependency only. There is no default OS controller and this
 * does not grant transport callers process authority. No target mutex wait. */
export class AdmittedRecoverExecutor{
 readonly #database:string;readonly #root:string;readonly #platform:PathPlatform;readonly #controller:RecoveryController;#busy=false;
 constructor(database:string,root:string,platform:PathPlatform,controller:RecoveryController){
  requireDiscordText(root);if(root.includes('\0')||Buffer.byteLength(root)>32768)throw new TypeError('Invalid recovery root');
  if(platform!=='win32'&&platform!=='posix')throw new TypeError('Invalid recovery platform');
  if(!(platform==='win32'?win32:posix).isAbsolute(root))throw new TypeError('Recovery root must be absolute');
  const functions={} as Record<keyof RecoveryController,Function>;
  for(const key of ['inspect','start','join'] as const){const fn=own(controller,key);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected startup controller function');functions[key]=fn;}
  this.#database=pinNativeRuntimePath(database);this.#root=root;this.#platform=platform;this.#controller=Object.freeze({inspect:(thread:string,signal:AbortSignal)=>Reflect.apply(functions.inspect,controller,[thread,signal]),start:(thread:string,identity:string,signal:AbortSignal)=>Reflect.apply(functions.start,controller,[thread,identity,signal]),join:()=>Reflect.apply(functions.join,controller,[])});Object.freeze(this);
 }
 requireDatabase(path:string):void{if(pinNativeRuntimePath(path)!==this.#database)throw new TypeError('Recovery executor database differs');}
 async execute(input:OriginalRecoveryInput,signal?:AbortSignal):Promise<ActionResult>{
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected recovery abort signal');
  if(this.#busy)throw new ActionExecutionError('Invalid','recovery controller already has an owned invocation');signal?.throwIfAborted();this.#busy=true;const owner=new NativeRecoveryOwner(this.#database);
  try{const claim=await owner.claimOriginal(input,signal),report=await handoffRecovery(owner,claim,this.#controller,this.#root,this.#platform,signal);
   return snapshotActionResult({text:`Recovery dispatched for ${report.thread}. Cancelled requests: ${report.cancelled.length}; already started or uncertain: ${report.startedOrUncertain}. Receipt: ${report.receipt}. Restart and tool readiness are not yet confirmed; do not replay cancelled requests.`,waitsForFinal:false,ui:null});
  }finally{try{await owner.close();}finally{this.#busy=false;}}
 }
}
Object.freeze(AdmittedRecoverExecutor.prototype);
