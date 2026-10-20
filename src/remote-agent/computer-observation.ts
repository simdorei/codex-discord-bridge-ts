import {randomUUID} from 'node:crypto';import {types} from 'node:util';import {performance} from 'node:perf_hooks';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';import {requireDiscordText} from '../discord/text.ts';
export interface RemoteComputerIdentity{readonly window_id:bigint;readonly process_id:bigint;readonly process_path:string;readonly title_digest:string;readonly left:bigint;readonly top:bigint;readonly width:bigint;readonly height:bigint;}
export type RemoteObservationFailureKind='FreshScreenshot'|'DifferentWindow'|'OutsideScreenshot'|'State';
const messages=Object.freeze({FreshScreenshot:'a fresh screenshot is required',DifferentWindow:'the screenshot belongs to a different window',OutsideScreenshot:'the requested coordinates are outside the screenshot',State:'computer controller state is unavailable'});
export class RemoteObservationError extends Error{readonly kind:RemoteObservationFailureKind;constructor(kind:RemoteObservationFailureKind){if(typeof kind!=='string'||!Object.hasOwn(messages,kind))throw new TypeError('Invalid observation failure');super(messages[kind]);this.name='RemoteObservationError';this.kind=kind;}}
function integer(value:unknown,min:bigint,max:bigint):bigint{if(typeof value!=='bigint'||value<min||value>max)throw new TypeError('Invalid native computer identity integer');return value;}
const u64=(v:unknown)=>integer(v,0n,18446744073709551615n),i64=(v:unknown)=>integer(v,-9223372036854775808n,9223372036854775807n);
function text(value:unknown,max:number):string{requireDiscordText(value);if(Buffer.byteLength(value)>max)throw new RangeError('Computer identity text exceeds byte limit');return value;}
function capture(identity:RemoteComputerIdentity):RemoteComputerIdentity{return Object.freeze({window_id:u64(own(identity,'window_id')),process_id:integer(own(identity,'process_id'),0n,4294967295n),process_path:text(own(identity,'process_path'),32768),title_digest:text(own(identity,'title_digest'),256),left:i64(own(identity,'left')),top:i64(own(identity,'top')),width:u64(own(identity,'width')),height:u64(own(identity,'height'))});}
/** One source-compatible screenshot observation; recording replaces the prior
 * one. Consumption removes before expiry/window/coordinate checks, even on
 * failure. Returned identity is not authority: the native platform must still
 * verify exact process/window identity immediately before an effect. */
export class RemoteComputerObservationOwner{
 readonly #ttl:number;readonly #now:()=>number;#last=0;#entry:Readonly<{id:string;identity:RemoteComputerIdentity;expires:number}>|null=null;
 constructor(ttlMs:number,now:()=>number=()=>performance.now()){if(!Number.isFinite(ttlMs)||ttlMs<0||ttlMs>3600000)throw new RangeError('Expected bounded observation TTL');if(typeof now!=='function'||types.isProxy(now)||types.isAsyncFunction(now)||types.isGeneratorFunction(now))throw new TypeError('Expected synchronous monotonic clock');this.#ttl=ttlMs;this.#now=now;}
 #time():number{const now=this.#now();if(typeof now!=='number'||!Number.isFinite(now)||now<0||now<this.#last)throw new RemoteObservationError('State');this.#last=now;return now;}
 record(identity:RemoteComputerIdentity):string{const captured=capture(identity),now=this.#time(),expires=now+this.#ttl;if(!Number.isFinite(expires))throw new RemoteObservationError('State');const id=randomUUID().replaceAll('-','');this.#entry=Object.freeze({id,identity:captured,expires});return id;}
 consume(observationId:string,windowId:bigint,points:readonly (readonly [bigint,bigint])[]):RemoteComputerIdentity{
  text(observationId,100);u64(windowId);if(types.isProxy(points)||!Array.isArray(points)||points.length>2)throw new TypeError('Expected at most two observed points');const owned:(readonly [bigint,bigint])[]=[];
  for(let i=0;i<points.length;i++){const point=own(points,String(i));if(types.isProxy(point)||!Array.isArray(point)||point.length!==2)throw new TypeError('Expected coordinate pair');owned.push([integer(own(point,'0'),0n,4294967295n),integer(own(point,'1'),0n,4294967295n)]);}
  const entry=this.#entry;if(entry===null||entry.id!==observationId)throw new RemoteObservationError('FreshScreenshot');this.#entry=null;
  if(this.#time()>=entry.expires)throw new RemoteObservationError('FreshScreenshot');if(entry.identity.window_id!==windowId)throw new RemoteObservationError('DifferentWindow');
  if(owned.some(([x,y])=>x>=entry.identity.width||y>=entry.identity.height))throw new RemoteObservationError('OutsideScreenshot');return entry.identity;
 }
 clear():void{this.#entry=null;}
}
Object.freeze(RemoteComputerObservationOwner.prototype);
