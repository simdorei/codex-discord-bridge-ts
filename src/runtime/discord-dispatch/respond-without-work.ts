import {types} from 'node:util';
import {interactionMessage,type InteractionResponse} from '../../discord/interaction-response.ts';
import type {GatewayShutdownClock} from '../../discord/gateway/shutdown.ts';
import {isPendingInteractionClaim,type InteractionClaim} from './claim-cache.ts';
import {acknowledgeUntil} from './acknowledge-until.ts';
import {InteractionDispatchError} from './errors.ts';
const consumed=new WeakSet<object>();
/** Consumes one live claim for a response that creates no work. Deadline/failure
 * releases it; only confirmed acknowledgement commits it. This does not stage
 * durable executable custody or enqueue commands. Caller relinquishes the guard. */
export async function respondWithoutWork(claim:InteractionClaim,send:(response:InteractionResponse,signal:AbortSignal)=>Promise<void>,content:string,deadline:number,force:AbortSignal,clock?:GatewayShutdownClock):Promise<'RespondedWithoutWork'|'DeadlineExceeded'>{
 if(typeof send!=='function'||types.isProxy(send)||types.isGeneratorFunction(send))throw new TypeError('Expected owned response transport');if(!isPendingInteractionClaim(claim)||consumed.has(claim))throw new InteractionDispatchError('ClaimState');consumed.add(claim);
 try{const response=interactionMessage(content,true);if(!await acknowledgeUntil(signal=>send(response,signal),deadline,force,clock))return 'DeadlineExceeded';if(!claim.commit())throw new InteractionDispatchError('ClaimState');return 'RespondedWithoutWork';}finally{claim.release();}
}
