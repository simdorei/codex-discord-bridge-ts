import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {interactionDispatchErrorInfo} from '../discord-dispatch/errors.ts';
import type {RuntimeWorkerResult} from './monitored-worker.ts';
export interface InteractionFailureReport{readonly lane:string;readonly interactionId:bigint;readonly error:string}
/** Only owned Acknowledge/Update failures belong to an individual interaction.
 * Claim/custody/state errors remain fatal to the lane. Never inspect unknown
 * error getters/toString; tokens are literally replaced before diagnostics. */
export function reportInteractionEventResult(lane:string,id:bigint,token:string,result:RuntimeWorkerResult,report:(value:InteractionFailureReport)=>void):RuntimeWorkerResult{
 requireDiscordText(lane);requireDiscordText(token);if(typeof id!=='bigint'||id<=0n||id>(1n<<64n)-1n)throw new TypeError('Expected interaction identity');if(result.ok)return result;const info=interactionDispatchErrorInfo(result.error);if(info===null||(info.kind!=='Acknowledge'&&info.kind!=='Update'))return result;
 invokeSynchronousVoid(report,{},[Object.freeze({lane,interactionId:id,error:token===''?info.text:info.text.replaceAll(token,'[REDACTED]')})]);return Object.freeze({ok:true});
}
