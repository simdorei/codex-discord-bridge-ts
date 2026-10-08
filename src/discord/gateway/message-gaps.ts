import {types} from 'node:util';
import {gatewayId,gatewayOwnField} from './values.ts';
import {BoundedBroadcast,type BroadcastPoll} from '../../app-server/broadcast.ts';
export type GatewayUnavailableReason='Full'|'Closed'|'Stopping'|'SequenceExhausted';
const bits:Readonly<Record<GatewayUnavailableReason,number>>=Object.freeze({Full:1,Closed:2,Stopping:4,SequenceExhausted:8});
const MAX=(1n<<64n)-1n;
export function saturatingGatewayIncrement(value:bigint):bigint{if(typeof value!=='bigint'||value<0n||value>MAX)throw new TypeError('Expected u64 gateway counter');return value===MAX?MAX:value+1n;}
export interface MessageGapPosition{readonly timestampMicros:bigint;readonly messageId:bigint}
export interface MessageGapSnapshot{readonly channelId:bigint;readonly earliest:MessageGapPosition;readonly reasonBits:number;readonly observationCount:bigint;readonly revision:bigint}
declare const noticeBrand:unique symbol;declare const fenceBrand:unique symbol;
export interface MessageGapNotice{readonly [noticeBrand]:true;snapshot():MessageGapSnapshot}
export interface MessageGapFence{readonly [fenceBrand]:true}
interface NoticeRecord{owner:object;snapshot:MessageGapSnapshot;live:boolean}
const notices=new WeakMap<object,NoticeRecord>(),fences=new WeakMap<object,{owner:object;channelId:bigint;revision:bigint}>();
interface Active{earliest:MessageGapPosition;reasonBits:number;observationCount:bigint}
interface Entry{revision:bigint;active:Active|null}
export class MessageGapStateError extends Error{constructor(){super('Discord message gap state lock is poisoned');this.name='MessageGapStateError';}}
export class MessageGapAckError extends Error{readonly kind:'ForeignTracker'|'RevisionExhausted'|'ConsumedNotice'|'StatePoisoned';constructor(kind:'ForeignTracker'|'RevisionExhausted'|'ConsumedNotice'|'StatePoisoned'){super(kind==='ForeignTracker'?'Discord message gap notice belongs to another tracker':kind==='RevisionExhausted'?'Discord message gap revision is exhausted and cannot be acknowledged safely':kind==='StatePoisoned'?'Discord message gap state lock is poisoned':'Discord message gap notice was already consumed');this.name='MessageGapAckError';this.kind=kind;}}
export class MessageGapFenceError extends Error{readonly kind:'ForeignTracker'|'Advanced'|'StatePoisoned';readonly channelId:bigint|null;constructor(kind:'ForeignTracker'|'Advanced'|'StatePoisoned',channelId:bigint|null=null){super(kind==='ForeignTracker'?'Discord message gap fence belongs to another tracker':kind==='StatePoisoned'?'Discord message gap state lock is poisoned':`Discord message gap advanced for channel ${channelId}`);this.name='MessageGapFenceError';this.kind=kind;this.channelId=channelId;}}
const id=gatewayId;
function earlier(a:MessageGapPosition,b:MessageGapPosition):MessageGapPosition{return a.timestampMicros<b.timestampMicros||(a.timestampMicros===b.timestampMicros&&a.messageId<b.messageId)?a:b;}
export interface MessageGapReceiver{
 snapshot():readonly MessageGapNotice[];changed(signal?:AbortSignal):Promise<void>;tryChanged():BroadcastPoll<void>;acknowledge(notice:MessageGapNotice):'Cleared'|'Stale';captureClearFence(channel:bigint):MessageGapFence|null;withCurrentFence<T>(fence:MessageGapFence,action:()=>T):T;dispose():void;
}
/** Synchronous single-event-loop publication/check/action barrier. Does not claim
 * cross-worker mutex parity. No message-gap API may reenter a fenced action; a
 * thrown action poisons future use rather than allowing an unverified clear claim.
 * Callbacks are trusted short synchronous work, never a detached async operation. */
export class MessageGapTracker{
 readonly #identity={};readonly #entries=new Map<bigint,Entry>();readonly #notifications=new BoundedBroadcast<void>(16);#locked=false;#poisoned=false;#closed=false;
 #available():void{if(this.#poisoned)throw new MessageGapStateError();if(this.#locked)throw new TypeError('Message gap API reentered a synchronous fence');}
 /** Check before a synchronous enqueue decision as well as before recording a gap. */
 assertPublicationReady():void{this.#available();if(this.#closed)throw new TypeError('Message gap tracker closed');}
 record(channelId:bigint,input:MessageGapPosition,reason:GatewayUnavailableReason):void{
  this.assertPublicationReady();id(channelId);const messageId=id(gatewayOwnField(input,'messageId')),timestampMicros=gatewayOwnField(input,'timestampMicros');if(typeof timestampMicros!=='bigint'||timestampMicros<-(1n<<63n)||timestampMicros>=(1n<<63n))throw new TypeError('Expected i64 gap timestamp');if(typeof reason!=='string'||!Object.hasOwn(bits,reason))throw new TypeError('Invalid gateway gap reason');
  const position=Object.freeze({timestampMicros,messageId}),entry=this.#entries.get(channelId)??{revision:0n,active:null};entry.revision=saturatingGatewayIncrement(entry.revision);
  if(entry.active===null)entry.active={earliest:position,reasonBits:bits[reason],observationCount:1n};else{entry.active.earliest=earlier(entry.active.earliest,position);entry.active.reasonBits|=bits[reason];entry.active.observationCount=saturatingGatewayIncrement(entry.active.observationCount);}
  this.#entries.set(channelId,entry);this.#notifications.send();
 }
 #snapshot():readonly MessageGapNotice[]{
  this.#available();const result:MessageGapNotice[]=[];
  for(const [channelId,entry] of [...this.#entries].sort(([a],[b])=>a<b?-1:a>b?1:0)){
   if(entry.active===null)continue;const snapshot=Object.freeze({channelId,earliest:entry.active.earliest,reasonBits:entry.active.reasonBits,observationCount:entry.active.observationCount,revision:entry.revision}),record:NoticeRecord={owner:this.#identity,snapshot,live:true};
   const notice=Object.freeze({snapshot:()=>{if(!record.live)throw new MessageGapAckError('ConsumedNotice');return snapshot;}}) as MessageGapNotice;notices.set(notice,record);result.push(notice);
  }return Object.freeze(result);
 }
 #ack(notice:MessageGapNotice):'Cleared'|'Stale'{
  if(this.#poisoned)throw new MessageGapAckError('StatePoisoned');this.#available();const record=typeof notice==='object'&&notice!==null?notices.get(notice):undefined;
  if(record===undefined)throw new MessageGapAckError('ForeignTracker');if(!record.live)throw new MessageGapAckError('ConsumedNotice');record.live=false;
  if(record.owner!==this.#identity)throw new MessageGapAckError('ForeignTracker');if(record.snapshot.revision===MAX)throw new MessageGapAckError('RevisionExhausted');const entry=this.#entries.get(record.snapshot.channelId);
  if(entry===undefined||entry.revision!==record.snapshot.revision||entry.active===null)return 'Stale';entry.active=null;if(!this.#closed)this.#notifications.send();return 'Cleared';
 }
 #capture(channelId:bigint):MessageGapFence|null{
  this.#available();id(channelId);const entry=this.#entries.get(channelId);if(entry?.active!==undefined&&entry.active!==null)return null;
  const token=Object.freeze({}) as MessageGapFence;fences.set(token,{owner:this.#identity,channelId,revision:entry?.revision??0n});return token;
 }
 #with<T>(fence:MessageGapFence,action:()=>T):T{
  if(this.#poisoned)throw new MessageGapFenceError('StatePoisoned');this.#available();const token=typeof fence==='object'&&fence!==null?fences.get(fence):undefined;if(token===undefined||token.owner!==this.#identity)throw new MessageGapFenceError('ForeignTracker');
  const entry=this.#entries.get(token.channelId);if((entry?.revision??0n)!==token.revision||(entry?.active!==undefined&&entry.active!==null))throw new MessageGapFenceError('Advanced',token.channelId);
  if(typeof action!=='function'||types.isProxy(action)||types.isAsyncFunction(action)||types.isGeneratorFunction(action))throw new TypeError('Gap fenced action must be synchronous');
  this.#locked=true;try{const result=action();if(types.isPromise(result)){void Promise.prototype.then.call(result,undefined,()=>undefined);throw new TypeError('Gap fenced action returned a Promise');}if(result!==null&&(typeof result==='object'||typeof result==='function')){let object:object|null=result;while(object!==null){if(types.isProxy(object))throw new TypeError('Gap fenced action returned a Proxy');const then=Object.getOwnPropertyDescriptor(object,'then');if(then!==undefined&&(!Object.hasOwn(then,'value')||typeof then.value==='function'))throw new TypeError('Gap fenced action returned a thenable');object=Object.getPrototypeOf(object);}}return result;}catch(error){this.#poisoned=true;throw error;}finally{this.#locked=false;}
 }
 subscribe():MessageGapReceiver{const receiver=this.#notifications.subscribe();let disposed=false;const live=()=>{if(disposed)throw new TypeError('Message gap receiver disposed');};return Object.freeze({snapshot:()=>{live();return this.#snapshot();},changed:(signal?:AbortSignal)=>receiver.receive(signal),tryChanged:()=>receiver.tryReceive(),acknowledge:(notice:MessageGapNotice)=>{live();return this.#ack(notice);},captureClearFence:(channel:bigint)=>{live();return this.#capture(channel);},withCurrentFence:<T>(fence:MessageGapFence,action:()=>T)=>{live();return this.#with(fence,action);},dispose:()=>{disposed=true;receiver.dispose();}});}
 close():void{if(this.#closed)return;if(this.#locked)throw new TypeError('Message gap API reentered a synchronous fence');this.#closed=true;this.#notifications.close();}
}
