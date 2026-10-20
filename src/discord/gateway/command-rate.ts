import {rustIntegerToF32 as integerF32} from '../../core/rust-f32.ts';
import type {GatewayControlCommand} from './session-machine.ts';
import {gatewayOwnField} from './values.ts';
const SECOND=1000000000n,MILLISECOND=1000000n,PERIOD=60n*SECOND,MAX_DURATION=((1n<<64n)*SECOND)-1n;
export function gatewayNonreservedCommands(heartbeatIntervalNs:bigint):number{
 if(typeof heartbeatIntervalNs!=='bigint'||heartbeatIntervalNs<0n||heartbeatIntervalNs>MAX_DURATION)throw new TypeError('Expected Rust Duration nanoseconds');
 const seconds=Math.fround(integerF32(heartbeatIntervalNs/SECOND)+Math.fround(integerF32(heartbeatIntervalNs%SECOND)/Math.fround(1000000000)));
 const heartbeats=Math.min(255,Math.ceil(Math.fround(Math.fround(60)/seconds))),reserved=Math.min(255,heartbeats+1);
 return Math.max(110,Math.max(0,120-reserved));
}
/** Source sliding-window log, including u16 relative millisecond quantization.
 * One nanosecond clock domain. Inspections don't rebase or consume permits;
 * successful acquire alone changes the log. Actual waiting belongs to the caller. */
export class GatewayCommandRateLimiter{
 readonly #max:number;#deadline:bigint;#offsets:number[]=[];#last:bigint;
 constructor(heartbeatIntervalNs:bigint,nowNs=0n){if(typeof nowNs!=='bigint'||nowNs<0n)throw new TypeError('Expected monotonic nanoseconds');this.#max=gatewayNonreservedCommands(heartbeatIntervalNs);this.#deadline=nowNs;this.#last=nowNs;Object.freeze(this);}
 get max():number{return this.#max;}
 #time(now:bigint):void{if(typeof now!=='bigint'||now<this.#last)throw new TypeError('Expected monotonic nanoseconds');this.#last=now;}
 #firstUnreleased(now:bigint):number{return this.#offsets.findIndex(offset=>this.#deadline+BigInt(offset)*MILLISECOND>now);}
 available(now:bigint):number{this.#time(now);if(now<this.#deadline)return this.#max-this.#offsets.length-1;const index=this.#firstUnreleased(now);return this.#max-(index<0?0:this.#offsets.length-index);}
 /** Informational source duration can be positive even when another permit is ready. */
 nextAvailableDelayNs(now:bigint):bigint{this.#time(now);return now>=this.#deadline?0n:this.#deadline-now;}
 readyAtNs(now:bigint):bigint{this.#time(now);return this.#offsets.length<this.#max-1||now>=this.#deadline?now:this.#deadline;}
 tryAcquire(now:bigint):boolean{
  this.#time(now);if(this.#offsets.length===this.#max-1&&now<this.#deadline)return false;
  if(now>=this.#deadline){const index=this.#firstUnreleased(now);if(index<0){this.#offsets=[];this.#deadline=now+PERIOD;return true;}const advance=this.#offsets[index]!;this.#offsets=this.#offsets.slice(index+1).map(offset=>offset-advance);this.#deadline+=BigInt(advance)*MILLISECOND;}
  const offset=(now+PERIOD-this.#deadline)/MILLISECOND;if(offset<0n||offset>65535n)throw new RangeError('Gateway command offset outside u16');this.#offsets.push(Number(offset));return true;
 }
 snapshot(){return Object.freeze({max:this.#max,baseDeadlineNs:this.#deadline,relativeReleaseMs:Object.freeze([...this.#offsets])});}
}
export function gatewayControlNeedsPermit(command:GatewayControlCommand):boolean{switch(gatewayOwnField(command,'kind')){case 'Identify':case 'Resume':return true;case 'Heartbeat':case 'Close':case 'FlushOnly':return false;default:throw new TypeError('Unknown Gateway control command');}}
