import {BoundedBroadcast,type BroadcastPoll} from '../../app-server/broadcast.ts';
import {gatewayId,gatewayOwnField} from './values.ts';
export interface GatewayIdentity{readonly userId:bigint;readonly applicationId:bigint}
export interface GatewayIdentityConflict{readonly established:GatewayIdentity;readonly observed:GatewayIdentity}
export interface GatewayStateReceiver<T>{snapshot():T;changed(signal?:AbortSignal):Promise<T>;tryChanged():BroadcastPoll<T>;dispose():void}
/** One event-loop owner. Identity and the first mismatch are sticky authoritative
 * state; bounded broadcasts are only hints, including for subscribers joining late. */
export class GatewayIdentityTracker{
 #identity:GatewayIdentity|null=null;#conflict:GatewayIdentityConflict|null=null;readonly #identities=new BoundedBroadcast<void>(4);readonly #conflicts=new BoundedBroadcast<void>(4);#closed=false;
 observe(input:GatewayIdentity):void{
  if(this.#closed)throw new TypeError('Gateway identity tracker closed');const observed=Object.freeze({userId:gatewayId(gatewayOwnField(input,'userId')),applicationId:gatewayId(gatewayOwnField(input,'applicationId'))});
  if(this.#identity===null){this.#identity=observed;this.#identities.send();}
  else if(this.#conflict===null&&(this.#identity.userId!==observed.userId||this.#identity.applicationId!==observed.applicationId)){this.#conflict=Object.freeze({established:this.#identity,observed});this.#conflicts.send();}
 }
 #receiver<T>(broadcast:BoundedBroadcast<void>,snapshot:()=>T):GatewayStateReceiver<T>{const receiver=broadcast.subscribe();let disposed=false;const read=()=>{if(disposed)throw new TypeError('Gateway identity receiver disposed');return snapshot();};return Object.freeze({snapshot:read,changed:async(signal?:AbortSignal)=>{await receiver.receive(signal);return read();},tryChanged:()=>{const value=receiver.tryReceive();return value.kind==='Value'?Object.freeze({kind:'Value' as const,value:read()}):value;},dispose:()=>{disposed=true;receiver.dispose();}});}
 subscribeIdentity():GatewayStateReceiver<GatewayIdentity|null>{return this.#receiver(this.#identities,()=>this.#identity);}
 subscribeConflict():GatewayStateReceiver<GatewayIdentityConflict|null>{return this.#receiver(this.#conflicts,()=>this.#conflict);}
 close():void{if(this.#closed)return;this.#closed=true;this.#identities.close();this.#conflicts.close();}
}
