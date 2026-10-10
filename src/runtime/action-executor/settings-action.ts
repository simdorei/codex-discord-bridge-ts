import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {listModels,rateLimits,resumeThreadWithTimeout,type ServiceTierUpdate,type ThreadSettingsUpdate} from '../../app-server/requests.ts';
import {ownedRequestFailure} from '../../app-server/request-client.ts';
import {extractThreadId} from '../../app-server/identity.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {BridgeState} from '../bridge-state.ts';
import {SettingsTargetResolver} from '../settings-binding.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {ControlTurnVerifier} from './control-turn.ts';
import {snapshotSettingsBinding,type FrozenSettingsBinding} from './settings-snapshot.ts';
import {ObservedSettings} from './settings-observation.ts';
import {settingsReady,applyOrConfirmSettings} from './settings-verification.ts';
import {canonicalModel,validateModelEffort,reserveRequested,reserveCatalog,reserveEffort,RESERVE_MODEL} from './model-catalog.ts';
import {InvalidActionRequestError,MissingActionAppServerError} from './errors.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
export interface SettingsChange {readonly reference:string|null;readonly model:string|null;readonly effort:string|null;readonly speed:string|null}
function capture(input:SettingsChange):SettingsChange {
 const value=cloneOwnedSerdeValue(input) as SettingsChange;
 for(const key of ['reference','model','effort','speed'] as const)if(value[key]!==null)requireDiscordText(value[key]);return value;
}
function requestedTier(speed:string|null):ServiceTierUpdate {
 if(speed===null)return {kind:'Unchanged'};if(speed==='standard')return {kind:'Clear'};if(speed==='fast')return {kind:'Set',value:'priority'};
 throw new InvalidActionRequestError('unsupported speed; use standard or fast');
}
/** Original-thread settings leaf. Admitted callers must separately establish the
 * stored command/actor binding and run this inside the original stop-origin scope. */
export class SettingsAction {
 readonly #selection:ActionThreadSelection;readonly #resolver:SettingsTargetResolver;readonly #bridge:BridgeState;readonly #server:PortableResidentLifecycle|null;readonly #control:ControlTurnVerifier;readonly #budget:number;
 constructor(selection:ActionThreadSelection,resolver:SettingsTargetResolver,bridge:BridgeState,server:PortableResidentLifecycle|null,control:ControlTurnVerifier,resumeTimeoutMs:number){
  resumeThreadWithTimeout('',resumeTimeoutMs);this.#selection=selection;this.#resolver=resolver;this.#bridge=bridge;this.#server=server;this.#control=control;this.#budget=Math.min(resumeTimeoutMs,20000);Object.freeze(this);
 }
 async settings(channel:bigint,input:SettingsChange,bindingInput:FrozenSettingsBinding|null=null,signal?:AbortSignal):Promise<ActionResult>{
  if(typeof channel!=='bigint'||channel<0n||channel>=1n<<64n)throw new TypeError('Expected u64 channel');const change=capture(input),binding=bindingInput===null?null:snapshotSettingsBinding(bindingInput);signal?.throwIfAborted();
  if(binding!==null)await this.#resolver.validate(binding,channel);signal?.throwIfAborted();
  const thread=binding!==null?this.#selection.resolveReference(binding.target,false):await this.#selection.resolveThread(channel,change.reference);signal?.throwIfAborted();const server=this.#server;if(server===null)throw new MissingActionAppServerError();
  if(change.model===null&&change.effort===null&&change.speed===null){
   const generation=server.generation();settingsReady(server,generation);const observed=server.observedThreadSettings(thread.id,generation);
   const text=observed===null?`대화 설정 · 현재 실행값 미확인\nthread: ${thread.id}\n마지막 저장 모델: ${thread.model}\n마지막 저장 추론: ${thread.reasoningEffort}\n속도: 확인된 기록 없음`:ObservedSettings.parse(observed[1]).display(thread.id,'마지막 서버 확인값');
   settingsReady(server,generation);if(change.reference===null&&(await this.#selection.target(channel))[0]!==thread.id)throw new InvalidActionRequestError('settings query target changed; no current-room settings confirmed');signal?.throwIfAborted();return snapshotActionResult({text,waitsForFinal:false,ui:null});
  }
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),this.#budget),owned=signal?AbortSignal.any([signal,deadline.signal]):deadline.signal;
  let lease;
  try {
   try{lease=await this.#control.lock(thread.id,owned);}catch(error){signal?.throwIfAborted();if(deadline.signal.aborted)throw new InvalidActionRequestError('settings control wait timed out; no update was sent');throw error;}
   try{return await this.#apply(channel,thread.id,server.generation(),change,binding,owned);}catch(error){signal?.throwIfAborted();if(deadline.signal.aborted)throw new InvalidActionRequestError('settings verification timed out; the update outcome is unverified, do not assume it was not applied');throw error;}
  }finally{clearTimeout(timer);lease?.release();}
 }
 async #route(channel:bigint,reference:string|null,thread:string,binding:FrozenSettingsBinding|null,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();if(binding!==null)await this.#resolver.validate(binding,channel);else if(reference===null&&(await this.#selection.target(channel))[0]!==thread)throw new InvalidActionRequestError('settings target changed; no replacement target will be used');signal.throwIfAborted();
 }
 async #apply(channel:bigint,thread:string,generation:bigint,change:SettingsChange,binding:FrozenSettingsBinding|null,signal:AbortSignal):Promise<ActionResult>{
  const server=this.#server!,{reference,model:requestedModel,effort,speed}=change;signal.throwIfAborted();let tier=requestedTier(speed);settingsReady(server,generation);
  let catalog=await server.execute(listModels(),generation,signal);signal.throwIfAborted();const requestedReserve=requestedModel!==null&&reserveRequested(requestedModel);
  if(requestedReserve){catalog=reserveCatalog(catalog,await server.execute(rateLimits(),generation,signal));signal.throwIfAborted();}
  const model=requestedModel===null?null:canonicalModel(catalog,requestedModel);await this.#route(channel,reference,thread,binding,signal);
  let resumed:unknown;
  try{resumed=await server.execute(resumeThreadWithTimeout(thread,8000),generation,signal);}catch(error){const failure=ownedRequestFailure(error);if(failure?.kind==='Remote'&&failure.code===-32600n&&failure.message.includes('already has an active writer'))throw new InvalidActionRequestError(`settings requires the app-server that owns original thread ${thread}; no fork was used because that would change which thread is affected. app-server error: ${failure.message}`);throw error;}
  signal.throwIfAborted();if(extractThreadId(resumed)!==thread)throw new InvalidActionRequestError('settings resume returned a different or missing thread; no update was sent');
  const current=ObservedSettings.fromResume(resumed),isReserve=(model??current.model)===RESERVE_MODEL;let appliedEffort=effort,storedSpeed=speed;
  if(isReserve){
   if(!requestedReserve){catalog=reserveCatalog(catalog,await server.execute(rateLimits(),generation,signal));signal.throwIfAborted();}
   if(speed==='fast')throw new InvalidActionRequestError('Luna Reserve uses standard speed; no settings update was sent');
   appliedEffort=reserveEffort(catalog,effort,current.effort);tier={kind:'Set',value:'default'};storedSpeed='standard';
  }else if(effort!==null)validateModelEffort(catalog,model??current.model,effort);
  const update:ThreadSettingsUpdate={model,effort:appliedEffort,effortClear:false,serviceTier:tier};settingsReady(server,generation);await this.#route(channel,reference,thread,binding,signal);
  const applied=await applyOrConfirmSettings(server,thread,generation,resumed,update,signal);signal.throwIfAborted();settingsReady(server,generation);await this.#route(channel,reference,thread,binding,signal);
  BridgeState.prototype.rememberThreadSettings.call(this.#bridge,thread,model,appliedEffort,storedSpeed);
  const text=applied.alreadyApplied?applied.settings.display(thread,'이미 적용된 설정 확인 · 변경 요청을 보내지 않음'):isReserve?applied.settings.display(thread,'Luna Reserve 설정 변경 확인 · 다음 요청부터 적용 (이전 실패 요청은 재실행하지 않음)'):model!==null&&effort===null&&speed===null?`모델이 변경되었습니다: ${applied.settings.model}`:applied.settings.display(thread,'설정 변경 확인 · 다음 요청부터 적용');
  return snapshotActionResult({text,waitsForFinal:false,ui:null});
 }
}
Object.freeze(SettingsAction.prototype);
