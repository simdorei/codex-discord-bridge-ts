import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {listModels,rateLimits,resumeThreadWithTimeout} from '../../app-server/requests.ts';
import {serdeField,rustTrim} from '../../app-server/value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {settingsReady} from './settings-verification.ts';
import {modelOptions,modelEffortOptions,reserveCatalog,RESERVE_MODEL} from './model-catalog.ts';
import {InvalidActionRequestError,MissingActionAppServerError} from './errors.ts';
/** Read-only catalog lookup. Optional Reserve discovery is isolated from normal
 * model availability; all nested native requests join cancellation before return. */
export class SettingsOptionsAction {
 readonly #selection:ActionThreadSelection;readonly #server:PortableResidentLifecycle|null;readonly #budget:number;
 constructor(selection:ActionThreadSelection,server:PortableResidentLifecycle|null,resumeTimeoutMs:number){resumeThreadWithTimeout('',resumeTimeoutMs);this.#selection=selection;this.#server=server;this.#budget=Math.min(resumeTimeoutMs,8000);Object.freeze(this);}
 async options(channel:bigint,reference:string|null,field:string|null,signal?:AbortSignal):Promise<ActionResult>{
  if(typeof channel!=='bigint'||channel<0n||channel>=1n<<64n)throw new TypeError('Expected u64 channel');for(const s of [reference,field])if(s!==null)requireDiscordText(s);signal?.throwIfAborted();
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),this.#budget),owned=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
  try{return await this.#read(channel,reference,field,owned);}catch(error){signal?.throwIfAborted();if(deadline.signal.aborted)throw new InvalidActionRequestError('settings options timed out while waiting for the server; lookup cancelled');throw error;}finally{clearTimeout(timer);}
 }
 async #read(channel:bigint,reference:string|null,field:string|null,signal:AbortSignal):Promise<ActionResult>{
  signal.throwIfAborted();const effort=field==='effort'||field==='reasoning',target=reference!==null||effort?await this.#selection.resolveThread(channel,reference):null;signal.throwIfAborted();
  const server=this.#server;if(server===null)throw new MissingActionAppServerError();const generation=server.generation();settingsReady(server,generation);
  let catalog=await server.execute(listModels(),generation,signal),reserveListed=false;signal.throwIfAborted();
  if(field===null||field==='model'){
   const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),2000),owned=AbortSignal.any([signal,deadline.signal]);
   try{const rates=await server.execute(rateLimits(),generation,owned);signal.throwIfAborted();catalog=reserveCatalog(catalog,rates);reserveListed=true;}catch{signal.throwIfAborted();}finally{clearTimeout(timer);}
  }
  let text:string;
  if(target!==null&&effort){
   const observation=server.observedThreadSettings(target.id,generation);let model=target.model,source='마지막 저장 모델 · 현재 실행값 미확인';
   if(observation!==null){const value=serdeField(observation[1],'model');if(typeof value!=='string'||rustTrim(value)==='')throw new InvalidActionRequestError('observed model is malformed; no effort options confirmed');model=value;source='마지막 서버 확인 모델';}
   if(model===RESERVE_MODEL){catalog=reserveCatalog(catalog,await server.execute(rateLimits(),generation,signal));signal.throwIfAborted();}
   text=`대화: ${target.id}\n${source}: ${model}\n${modelEffortOptions(catalog,model)}`;
  }else {const options=modelOptions(catalog,field);text=target===null?options:`대화: ${target.id}\n${options}`;}
  if(reserveListed)text+='\nLuna Reserve: !settings --model reserve (gpt-reserve, standard; 일반 Luna와 별도)';
  settingsReady(server,generation);if(reference===null&&target!==null&&(await this.#selection.target(channel))[0]!==target.id)throw new InvalidActionRequestError('settings option target changed');signal.throwIfAborted();return snapshotActionResult({text,waitsForFinal:false,ui:null});
 }
}
Object.freeze(SettingsOptionsAction.prototype);
