import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {GatewayIngress,type DecodedGatewayEvent,type GatewayPublishOutcome,type ReceiveErrorOutcome} from './ingress.ts';
import {saturatingGatewayIncrement} from './message-gaps.ts';
export interface GatewayPublicationSnapshot{readonly ignored:bigint;readonly interactionsAccepted:bigint;readonly hardDroppedInteractions:bigint;readonly messagesAccepted:bigint;readonly recoverableMessageGaps:bigint;readonly receiveErrorsAccepted:bigint;readonly receiveErrorsDropped:bigint}
export interface GatewayReceiveErrorDrop{readonly shard:number;readonly message:string;readonly reason:'Full'|'Closed'}
/** Publication order: sticky identity -> typed observer -> owned lane -> outcome
 * accounting. Receive-error drops go to one required synchronous diagnostic sink
 * before their outcome is recorded; this replaces direct stderr writes in the owner. */
export class GatewayPublication<I extends object>{
 readonly #ingress:GatewayIngress<I>;readonly #reportDrop:(drop:GatewayReceiveErrorDrop)=>void;
 readonly #counts:{-readonly [K in keyof GatewayPublicationSnapshot]:bigint}={ignored:0n,interactionsAccepted:0n,hardDroppedInteractions:0n,messagesAccepted:0n,recoverableMessageGaps:0n,receiveErrorsAccepted:0n,receiveErrorsDropped:0n};
 constructor(ingress:GatewayIngress<I>,reportDrop:(drop:GatewayReceiveErrorDrop)=>void){this.#ingress=ingress;this.#reportDrop=reportDrop;}
 snapshot():GatewayPublicationSnapshot{return Object.freeze({...this.#counts});}
 publish(input:DecodedGatewayEvent<I>,receivedAtMs:number,typedObserver?:()=>void):GatewayPublishOutcome{
  const outcome=this.#ingress.publish(input,receivedAtMs,typedObserver);
  const key:keyof GatewayPublicationSnapshot=outcome.kind==='Ignored'?'ignored':outcome.kind==='InteractionAccepted'?'interactionsAccepted':outcome.kind==='InteractionHardDropped'?'hardDroppedInteractions':outcome.kind==='MessageAccepted'?'messagesAccepted':'recoverableMessageGaps';
  this.#counts[key]=saturatingGatewayIncrement(this.#counts[key]);return outcome;
 }
 publishReceiveError(shard:number,message:string):ReceiveErrorOutcome{
  const outcome=this.#ingress.publishReceiveError(shard,message);if(outcome.kind==='Dropped')invokeSynchronousVoid(this.#reportDrop,{},[Object.freeze({shard,message,reason:outcome.reason})]);const key=outcome.kind==='Accepted'?'receiveErrorsAccepted':'receiveErrorsDropped';this.#counts[key]=saturatingGatewayIncrement(this.#counts[key]);return outcome;
 }
}
