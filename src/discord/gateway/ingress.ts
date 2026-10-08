import {BoundedBroadcast,type BroadcastPoll} from '../../app-server/broadcast.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {GatewayIdentityTracker,type GatewayIdentity,type GatewayStateReceiver} from './identity.ts';
import {MessageGapTracker,MessageGapStateError,saturatingGatewayIncrement,type GatewayUnavailableReason} from './message-gaps.ts';
import {GatewayIngressLane,type IngressLaneReceiver} from './lane.ts';
import {gatewayOwnField,gatewayImmutableData} from './values.ts';
import {isEmergencyMessage} from './routing.ts';
import {isDecodedGatewayMessage,type DecodedGatewayMessage} from './decoded-message.ts';
export interface GatewayIngressConfig{readonly interactionCapacity:number;readonly reservedInteractionCapacity:number;readonly messageCapacity:number;readonly receiveErrorCapacity:number}
export const DEFAULT_GATEWAY_INGRESS_CONFIG:GatewayIngressConfig=Object.freeze({interactionCapacity:64,reservedInteractionCapacity:4,messageCapacity:1024,receiveErrorCapacity:16});
export type GatewayInteractionTag='Normal'|'Busy'|'Stopping';
export type DecodedGatewayEvent<I extends object>={readonly kind:'Ready';readonly identity:GatewayIdentity}|{readonly kind:'Interaction';readonly event:I}|{readonly kind:'Message';readonly event:DecodedGatewayMessage}|{readonly kind:'Ignored'|'GatewayClose'};
export interface InteractionIngress<I>{readonly sequence:bigint;readonly receivedAtMs:number;readonly tag:GatewayInteractionTag;readonly event:I}
export interface MessageIngress{readonly sequence:bigint;readonly event:DecodedGatewayMessage}
export interface GatewayReceiveError{readonly shard:number;readonly message:string}
export type GatewayPublishOutcome={readonly kind:'Ignored'}|{readonly kind:'InteractionAccepted';readonly sequence:bigint;readonly tag:GatewayInteractionTag}|{readonly kind:'InteractionHardDropped';readonly reason:GatewayUnavailableReason}|{readonly kind:'MessageAccepted';readonly sequence:bigint}|{readonly kind:'MessageRecoverableGap';readonly reason:GatewayUnavailableReason;readonly tracking:{readonly ok:true}|{readonly ok:false;readonly error:MessageGapStateError}};
export type ReceiveErrorOutcome={readonly kind:'Accepted'}|{readonly kind:'Dropped';readonly reason:'Full'|'Closed'};
export interface GatewayIngressReceivers<I>{readonly normalInteractions:IngressLaneReceiver<InteractionIngress<I>>;readonly reservedInteractions:IngressLaneReceiver<InteractionIngress<I>>;readonly messages:IngressLaneReceiver<MessageIngress>;readonly emergencyMessages:IngressLaneReceiver<MessageIngress>;readonly receiveErrors:IngressLaneReceiver<GatewayReceiveError>}
export interface GatewayIngressDiagnostics{readonly hardDroppedInteractions:bigint;readonly recoverableMessageGaps:bigint}
export class GatewayIngressConfigError extends RangeError{readonly lane:string;constructor(lane:string){super(`Discord gateway ${lane} ingress capacity must be greater than zero`);this.name='GatewayIngressConfigError';this.lane=lane;}}
const MAX=(1n<<64n)-1n;
export function nextGatewaySequence(last:bigint):bigint|null{if(typeof last!=='bigint'||last<0n||last>MAX)throw new TypeError('Expected u64 sequence');return last===MAX?null:last+1n;}
let processLastSequence=0n;
function nextProcessSequence():bigint|null{const next=nextGatewaySequence(processLastSequence);if(next!==null)processLastSequence=next;return next;}
const consumedEvents=new WeakSet<object>();
/** Pure synchronous typed ingress. Interaction payloads are already-decoded deeply
 * immutable DTOs supplied by the future full Gateway decoder; this generic port is
 * not a permissive network decoder. Message payloads require our full decoder brand.
 * Every call routes into at most one bounded lane, never awaits or authorizes a command.
 * Supported custom capacities: positive safe integers <=2^20; clock profile is ms. */
export class GatewayIngress<I extends object>{
 readonly #normal:GatewayIngressLane<InteractionIngress<I>>;readonly #reserved:GatewayIngressLane<InteractionIngress<I>>;readonly #messages:GatewayIngressLane<MessageIngress>;readonly #emergency=new GatewayIngressLane<MessageIngress>(4);readonly #errors:GatewayIngressLane<GatewayReceiveError>;
 readonly #identity=new GatewayIdentityTracker();readonly #gaps=new MessageGapTracker();readonly #hints=new BoundedBroadcast<void>(16);readonly receivers:GatewayIngressReceivers<I>;
 #accepting=true;#closed=false;#hard=0n;#recoverable=0n;
 constructor(config:GatewayIngressConfig=DEFAULT_GATEWAY_INGRESS_CONFIG){
  const values={} as Record<keyof GatewayIngressConfig,number>;
  for(const [key,lane] of [['interactionCapacity','NormalInteraction'],['reservedInteractionCapacity','ReservedInteraction'],['messageCapacity','Message'],['receiveErrorCapacity','ReceiveError']] as const){const value=gatewayOwnField(config,key);if(value===0)throw new GatewayIngressConfigError(lane);if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>1048576)throw new RangeError('Unsupported gateway ingress capacity');values[key]=value;}
  this.#normal=new GatewayIngressLane(values.interactionCapacity);this.#reserved=new GatewayIngressLane(values.reservedInteractionCapacity);this.#messages=new GatewayIngressLane(values.messageCapacity);this.#errors=new GatewayIngressLane(values.receiveErrorCapacity);
  this.receivers=Object.freeze({normalInteractions:this.#normal.receiver(),reservedInteractions:this.#reserved.receiver(),messages:this.#messages.receiver(),emergencyMessages:this.#emergency.receiver(),receiveErrors:this.#errors.receiver()});
 }
 stopAccepting():void{this.#accepting=false;}
 subscribeIdentity(){return this.#identity.subscribeIdentity();}
 subscribeIdentityConflict(){return this.#identity.subscribeConflict();}
 subscribeMessageGaps(){return this.#gaps.subscribe();}
 subscribeDiagnostics():GatewayStateReceiver<GatewayIngressDiagnostics>{const receiver=this.#hints.subscribe();let disposed=false;const snapshot=()=>{if(disposed)throw new TypeError('Gateway diagnostics receiver disposed');return Object.freeze({hardDroppedInteractions:this.#hard,recoverableMessageGaps:this.#recoverable});};return Object.freeze({snapshot,changed:async(signal?:AbortSignal)=>{await receiver.receive(signal);return snapshot();},tryChanged:():BroadcastPoll<GatewayIngressDiagnostics>=>{const p=receiver.tryReceive();return p.kind==='Value'?{kind:'Value',value:snapshot()}:p;},dispose:()=>{disposed=true;receiver.dispose();}});}
 #hardDrop(reason:GatewayUnavailableReason):GatewayPublishOutcome{this.#hard=saturatingGatewayIncrement(this.#hard);this.#hints.send();return Object.freeze({kind:'InteractionHardDropped',reason});}
 #gap(event:DecodedGatewayMessage,reason:GatewayUnavailableReason):GatewayPublishOutcome{
  let tracking:{readonly ok:true}|{readonly ok:false;readonly error:MessageGapStateError}=Object.freeze({ok:true});
  try{this.#gaps.record(event.channel_id,{messageId:event.id,timestampMicros:event.timestamp.unixNanoseconds/1000n},reason);}catch(error){if(!(error instanceof MessageGapStateError))throw error;tracking=Object.freeze({ok:false,error});}
  this.#recoverable=saturatingGatewayIncrement(this.#recoverable);this.#hints.send();return Object.freeze({kind:'MessageRecoverableGap',reason,tracking});
 }
 publish(input:DecodedGatewayEvent<I>,receivedAtMs:number,observer:()=>void=()=>{}):GatewayPublishOutcome{
  if(this.#closed)throw new TypeError('Gateway ingress closed');if(!Number.isFinite(receivedAtMs)||receivedAtMs<0)throw new TypeError('Expected monotonic receive time');
  const kind=gatewayOwnField(input,'kind');if(consumedEvents.has(input))throw new TypeError('Gateway event already moved');
  if(kind==='Ready'){const identity=gatewayOwnField(input,'identity') as GatewayIdentity;this.#identity.observe(identity);consumedEvents.add(input);invokeSynchronousVoid(observer,{});return Object.freeze({kind:'Ignored'});}
  if(kind==='Ignored'||kind==='GatewayClose'){consumedEvents.add(input);invokeSynchronousVoid(observer,{});return Object.freeze({kind:'Ignored'});}
  const event=gatewayOwnField(input,'event');
  if(kind==='Interaction'){
   if(event===null||typeof event!=='object')throw new TypeError('Expected immutable decoded interaction DTO');gatewayImmutableData(event);consumedEvents.add(input);invokeSynchronousVoid(observer,{});
   const sequence=nextProcessSequence();if(sequence===null)return this.#hardDrop('SequenceExhausted');let tag:GatewayInteractionTag=this.#accepting?'Normal':'Stopping';
   if(tag==='Normal'){const offered=this.#normal.trySend(Object.freeze({sequence,receivedAtMs,tag,event:event as I}));if(offered==='Accepted')return Object.freeze({kind:'InteractionAccepted',sequence,tag});tag='Busy';}
   const offered=this.#reserved.trySend(Object.freeze({sequence,receivedAtMs,tag,event:event as I}));return offered==='Accepted'?Object.freeze({kind:'InteractionAccepted',sequence,tag}):this.#hardDrop(offered);
  }
  if(kind==='Message'){
   if(!isDecodedGatewayMessage(event))throw new TypeError('Expected owned complete Gateway Message');consumedEvents.add(input);invokeSynchronousVoid(observer,{});this.#gaps.assertPublicationReady();
   if(!this.#accepting)return this.#gap(event,'Stopping');const sequence=nextProcessSequence();if(sequence===null)return this.#gap(event,'SequenceExhausted');
   const offered=(isEmergencyMessage(event.content)?this.#emergency:this.#messages).trySend(Object.freeze({sequence,event}));return offered==='Accepted'?Object.freeze({kind:'MessageAccepted',sequence}):this.#gap(event,offered);
  }
  throw new TypeError('Unknown decoded gateway event kind');
 }
 publishReceiveError(shard:number,message:string):ReceiveErrorOutcome{if(this.#closed)throw new TypeError('Gateway ingress closed');if(!Number.isInteger(shard)||shard<0||shard>4294967295||typeof message!=='string'||/[\uD800-\uDFFF]/u.test(message))throw new TypeError('Invalid gateway receive error');const offered=this.#errors.trySend(Object.freeze({shard,message}));return Object.freeze(offered==='Accepted'?{kind:'Accepted'}:{kind:'Dropped',reason:offered});}
 /** Stops senders and drains existing lane values; receiver dispose explicitly drops
  * them. This is not retroactive cancellation of already accepted source events. */
 close():void{if(this.#closed)return;this.#closed=true;this.#accepting=false;this.#normal.close();this.#reserved.close();this.#messages.close();this.#emergency.close();this.#errors.close();this.#identity.close();this.#gaps.close();this.#hints.close();}
}
