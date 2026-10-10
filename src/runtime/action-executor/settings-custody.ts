import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {stopOriginForIngress} from '../../store/stop-revision-read.ts';
import {withStopOrigin} from '../../app-server/dispatch-origin.ts';
import {serdeField,serdeObject} from '../../app-server/value.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serdeValueEqual} from '../../core/serde-value-equal.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {AUTO_RESERVE_REMOVED} from '../../discord/interaction-routing.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
import {snapshotSettingsBinding} from './settings-snapshot.ts';
import {SettingsAction,type SettingsChange} from './settings-action.ts';
import {InvalidActionRequestError} from './errors.ts';
export type BoundSettingsCommand={readonly Settings:SettingsChange}|{readonly AutoReserve:{readonly reference:string|null;readonly enabled:boolean}};
export interface SettingsActor {readonly channelId:bigint;readonly userId:bigint}
function command(input:BoundSettingsCommand):BoundSettingsCommand {
 const value=cloneOwnedSerdeValue(input);if(!serdeObject(value)||Object.keys(value).length!==1)throw new TypeError('Expected settings command');
 const settings=serdeField(value,'Settings'),auto=serdeField(value,'AutoReserve');
 if(settings!==undefined){if(!serdeObject(settings)||Object.keys(settings).length!==4)throw new TypeError('Expected exact settings fields');for(const key of ['reference','model','effort','speed'])if(serdeField(settings,key)!==null)requireDiscordText(serdeField(settings,key));}
 else {if(!serdeObject(auto)||Object.keys(auto).length!==2||typeof serdeField(auto,'enabled')!=='boolean')throw new TypeError('Expected auto-reserve description');if(serdeField(auto,'reference')!==null)requireDiscordText(serdeField(auto,'reference'));}
 return value as unknown as BoundSettingsCommand;
}
/** Server-stored original admission only. Never refresh a missing legacy stop
 * revision, trust a caller-supplied binding or redirect to a replacement thread. */
export class AdmittedSettingsExecutor {
 readonly #path:string;readonly #settings:SettingsAction;
 constructor(path:string,settings:SettingsAction){requireDiscordText(path);this.#path=path;this.#settings=settings;Object.freeze(this);}
 async execute(input:SettingsActor,actionInput:BoundSettingsCommand,key:string,signal?:AbortSignal):Promise<ActionResult>{
  const context=cloneOwnedSerdeValue(input) as SettingsActor;for(const id of [context.channelId,context.userId])if(typeof id!=='bigint'||id<0n||id>=1n<<64n)throw new TypeError('Expected u64 settings actor');
  requireDiscordText(key);const action=command(actionInput),settings=serdeField(action,'Settings') as SettingsChange|undefined;signal?.throwIfAborted();
  if(settings!==undefined&&settings.model===null&&settings.effort===null&&settings.speed===null)return this.#settings.settings(context.channelId,settings,null,signal);
  const original=await state.getIngress(this.#path,key);signal?.throwIfAborted();if(original===null)throw new InvalidActionRequestError('original admission record is missing');
  const frozen=stopOriginForIngress(original);
  return withStopOrigin(frozen??null,async()=>{
   const record=await state.getIngress(this.#path,key);signal?.throwIfAborted();if(record===null)throw new InvalidActionRequestError('settings admission record is missing');
   if(record.channelId!==context.channelId||record.ownerUserId!==context.userId)throw new InvalidActionRequestError('settings admission owner or channel differs');
   let binding;try{binding=snapshotSettingsBinding(serdeField(record.payload,'settings_binding')??null);}catch{throw new InvalidActionRequestError('settings target was not frozen before admission; request will not be redirected');}
   if(record.targetThreadId!==binding.target)throw new InvalidActionRequestError('settings admission target identity differs');
   if(!serdeValueEqual(action,binding.command))throw new InvalidActionRequestError('settings command differs from its admitted envelope');
   if(settings===undefined)return snapshotActionResult({text:AUTO_RESERVE_REMOVED,waitsForFinal:false,ui:null});
   return this.#settings.settings(context.channelId,settings,binding,signal);
  });
 }
}
Object.freeze(AdmittedSettingsExecutor.prototype);
