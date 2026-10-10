import {types} from 'node:util';
import {ownedResidentFailure} from '../../app-server/resident-state.ts';
import {ownedRequestFailure} from '../../app-server/request-client.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {ActionExecutionError} from './action-error.ts';
function field(value:unknown,key:string):unknown{if(value===null||typeof value!=='object'||types.isProxy(value))return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;}
function activeWriter(error:unknown):boolean{const detail=ownedRequestFailure(error),message=field(detail,'message');return field(detail,'kind')==='Remote'&&field(detail,'code')===-32600n&&typeof message==='string'&&message.includes('already has an active writer');}
export function originalOwnerActionError(operation:string,thread:string,error:unknown):ActionExecutionError{
 requireDiscordText(operation);requireDiscordText(thread);return activeWriter(error)?new ActionExecutionError('Invalid',`${operation} requires the app-server that owns original thread ${thread}; no fork was used because that would change which thread is affected. app-server error: ${passiveErrorText(error,'app-server failed')}`):new ActionExecutionError('AppServer',error);
}
/** Central archive failure disposition. Only exact owned pre-effect failure
 * variants release an attempted reservation; ambiguous outcomes remain fenced. */
export async function archiveDispatchFailure(path:string,reservation:string,thread:string,error:unknown):Promise<ActionExecutionError>{
 requireDiscordText(path);requireDiscordText(reservation);requireDiscordText(thread);const kind=field(ownedResidentFailure(error),'kind');
 if(kind==='GenerationMismatch'||kind==='GenerationQuarantined'||kind==='DeadGenerationFence'||activeWriter(error)){
  try{await state.releaseRejectedArchive(path,reservation);}
  catch(release){return new ActionExecutionError('Invalid',`archive was rejected before effect, but its reservation could not be released and remains protected: ${passiveErrorText(release,'reservation release failed')}. Original error: ${passiveErrorText(error,'app-server failed')}`);}
  return originalOwnerActionError('archive',thread,error);
 }
 return new ActionExecutionError('Invalid',`archive attempt for ${thread} has an unverified outcome; some conversations may already be archived; its reservation remains protected; do not automatically retry. Original app-server error: ${passiveErrorText(error,'app-server failed')}`);
}
