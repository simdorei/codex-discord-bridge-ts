import {types} from 'node:util';
import type {MessageIngress} from './ingress.ts';
import {GatewayIngressLane,type IngressLaneReceiver,type IngressLanePoll} from './lane.ts';
import {isDecodedGatewayMessage} from './decoded-message.ts';
import {gatewayOwnField,gatewayId} from './values.ts';
/** The receiver owns at most one removed original until its actual operation has
 * joined. Disposing the lane releases queued originals, never that active one. */
export interface GatewayMessageIngressReceiver extends IngressLaneReceiver<MessageIngress>{complete(original:MessageIngress):void}
const authority=Symbol('accepted Gateway messages'),deferrals=new WeakSet<object>();
class AcceptedGatewayMessageDeferral extends Error{
 constructor(token:symbol){super('Accepted Gateway message still owns its original disposition');if(token!==authority)throw new TypeError('Expected accepted Gateway deferral');this.name='AcceptedGatewayMessageDeferral';deferrals.add(this);Object.freeze(this);}
}
export function isAcceptedGatewayMessageDeferral(error:unknown):boolean{return error!==null&&typeof error==='object'&&deferrals.has(error);}
/** Read-only veto, not admission or execution authority. Only the matching
 * ingress owner can change the live membership behind this view. */
export class GatewayAcceptedMessageView{
 readonly #check:(channel:bigint,message:bigint)=>void;readonly #size:()=>number;
 constructor(token:symbol,check:(channel:bigint,message:bigint)=>void,size:()=>number){if(token!==authority)throw new TypeError('Expected accepted Gateway message view');this.#check=check;this.#size=size;Object.freeze(this);}
 assertDiscardable(channel:bigint,message:bigint):void{gatewayId(channel);gatewayId(message);this.#check(channel,message);}
 get size():number{return this.#size();}
}
Object.freeze(GatewayAcceptedMessageView.prototype);
export function captureAcceptedGatewayMessages(value:unknown):GatewayAcceptedMessageView|null{
 if(value===undefined)return null;if(value===null||types.isProxy(value)||!(value instanceof GatewayAcceptedMessageView))throw new TypeError('Expected original accepted Gateway message view');
 Object.getOwnPropertyDescriptor(GatewayAcceptedMessageView.prototype,'size')!.get!.call(value);return value;
}
/** Bookkeeping contains only exact identity counts and weak envelope receipts,
 * not another payload queue. The two existing queues plus one active receipt per
 * lane bound membership to normalCapacity + 4 + 2, including receive races. */
export function createGatewayMessageCustody(normalCapacity:number){
 const counts=new Map<bigint,Map<bigint,number>>();let size=0;
 const receipts=new WeakMap<MessageIngress,{readonly channel:bigint;readonly message:bigint;readonly event:MessageIngress['event'];live:boolean}>();
 const retain=(original:MessageIngress)=>{if(receipts.has(original))throw new TypeError('Gateway original already accepted');const channel=original.event.channel_id,message=original.event.id,ids=counts.get(channel)??new Map<bigint,number>();ids.set(message,(ids.get(message)??0)+1);counts.set(channel,ids);receipts.set(original,{channel,message,event:original.event,live:true});size++;};
 const release=(original:MessageIngress)=>{const receipt=receipts.get(original);if(receipt===undefined||receipt.event!==original.event)throw new TypeError('Foreign Gateway original');if(!receipt.live)return;receipt.live=false;const ids=counts.get(receipt.channel)!,count=ids.get(receipt.message)!;if(count===1)ids.delete(receipt.message);else ids.set(receipt.message,count-1);if(ids.size===0)counts.delete(receipt.channel);size--;};
 const view=new GatewayAcceptedMessageView(authority,(channel,message)=>{if(counts.get(channel)?.has(message))throw new AcceptedGatewayMessageDeferral(authority);},()=>size);
 const lane=(capacity:number)=>{
  const queue=new GatewayIngressLane<MessageIngress>(capacity,release),source=queue.receiver();let active:MessageIngress|null=null,receiving=false,disposed=false;const completed=new WeakSet<MessageIngress>();
  const available=()=>{if(receiving||active!==null)throw new TypeError('Gateway message original still owned');};
  const take=(original:MessageIngress)=>{if(active!==null)throw new TypeError('Gateway message original still owned');active=original;return original;};
  const receiver:GatewayMessageIngressReceiver=Object.freeze({
   get length(){return source.length;},
   tryReceive:():IngressLanePoll<MessageIngress>=>{available();const value=source.tryReceive();return value.kind==='Value'?Object.freeze({kind:'Value',value:take(value.value)}):value;},
   receive:async(signal?:AbortSignal)=>{available();receiving=true;try{const original=await source.receive(signal);return original===null?null:take(original);}finally{receiving=false;}},
   complete:(original:MessageIngress)=>{if(completed.has(original))return;if(active!==original)throw new TypeError('Gateway message original belongs to another receiver or operation');release(original);active=null;completed.add(original);},
   close:()=>source.close(),
   dispose:()=>{if(disposed)return;disposed=true;source.dispose();},
  });
  return Object.freeze({receiver,trySend:(original:MessageIngress)=>{if(original===null||typeof original!=='object'||types.isProxy(original)||!Object.isFrozen(original)||!isDecodedGatewayMessage(gatewayOwnField(original,'event')))throw new TypeError('Expected immutable Gateway original');gatewayId(gatewayOwnField(original,'sequence'));if(receipts.has(original))throw new TypeError('Gateway original already accepted');const result=queue.trySend(original);if(result==='Accepted')retain(original);return result;},close:()=>queue.close()});
 };
 return Object.freeze({normal:lane(normalCapacity),emergency:lane(4),view});
}
