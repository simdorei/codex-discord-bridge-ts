import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {snapshotStoredIngress} from '../../store/ingress-snapshot.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serdeField} from '../../app-server/value.ts';
import {serdeValueEqual} from '../../core/serde-value-equal.ts';
import {requireDiscordText} from '../../discord/text.ts';
export interface LifecycleActor {readonly channelId:bigint;readonly userId:bigint;readonly discordMessageId:bigint|null;}
import {snapshotSettingsBinding} from './settings-snapshot.ts';
import {InvalidActionRequestError,ActionIntegerRangeError} from './errors.ts';
/** Read server-stored message lifecycle custody; returned snapshot never refreshes
 * a legacy binding/revision or grants a different actor/command/target. */
export async function loadLifecycleAdmission(path:string,input:LifecycleActor,kind:'Archive'|'Resume'|'Stop',reference:string|null,key:string,signal?:AbortSignal){
 requireDiscordText(path);requireDiscordText(key);if(reference!==null)requireDiscordText(reference);if(kind!=='Archive'&&kind!=='Resume'&&kind!=='Stop')throw new TypeError('Unsupported lifecycle admission kind');
 const actor=cloneOwnedSerdeValue(input) as LifecycleActor;for(const id of [actor.channelId,actor.userId,actor.discordMessageId]){if(typeof id!=='bigint'||id<0n||id>=1n<<64n)throw new TypeError('Expected admitted u64 lifecycle actor');if(id>=1n<<63n)throw new ActionIntegerRangeError();}
 signal?.throwIfAborted();const found=await state.getIngress(path,key);signal?.throwIfAborted();if(found===null)throw new InvalidActionRequestError('lifecycle admission record is missing');const record=snapshotStoredIngress(found),command={[kind]:{reference}};
 if(record.kind!=='message'||record.channelId!==actor.channelId||record.ownerUserId!==actor.userId||record.eventId!==actor.discordMessageId||record.sourceMessageId!==actor.discordMessageId||record.state!=='executing'||record.phase!=='processing'||record.ownerId!==null||serdeField(record.payload,'version')!==1n||!serdeValueEqual(serdeField(record.payload,'plan'),{Execute:command}))throw new InvalidActionRequestError('lifecycle original command/user/channel envelope differs; no replacement target or lifecycle RPC will be used');
 let binding;try{binding=snapshotSettingsBinding(serdeField(record.payload,'lifecycle_binding')??null);}catch{throw new InvalidActionRequestError('lifecycle original target was not frozen; legacy request remains preserved');}
 if(!serdeValueEqual(binding.command,command)||record.targetThreadId!==binding.target)throw new InvalidActionRequestError('lifecycle admitted command or target identity differs');
 return Object.freeze({actor,record,binding});
}
