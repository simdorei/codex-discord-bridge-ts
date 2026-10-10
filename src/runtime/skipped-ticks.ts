import {performance} from "node:perf_hooks";
import type {TickSource} from "./delayed-ticks.ts";
/** Immediate first tick, then monotonic millisecond phase-aligned skipping. No
 * missed-tick queue or catch-up burst; not Tokio's exact submillisecond tolerance. */
export function nextSkippedDeadline(previous:number,now:number,period:number):number{
  if(!Number.isFinite(previous)||!Number.isFinite(now)||now<previous||!Number.isSafeInteger(period)||period<=0)throw new RangeError("Invalid monotonic skipped tick");return previous+Math.max(1,Math.floor((now-previous)/period)+1)*period;
}
export class SkippedTicks implements TickSource{
  readonly #period:number;#next=performance.now();#timer:ReturnType<typeof setTimeout>|undefined;#resolve:(()=>void)|undefined;#closed=false;
  constructor(period:number){if(!Number.isSafeInteger(period)||period<=0||period>2147483647)throw new RangeError("Expected positive native tick interval");this.#period=period;}
  wait():Promise<void>{
    if(this.#closed)return Promise.resolve();if(this.#resolve)throw new TypeError("Only one pending tick waiter is allowed");
    return new Promise(resolve=>{this.#resolve=resolve;const poll=()=>{if(this.#closed){this.#resolve=undefined;resolve();return;}const now=performance.now();if(now<this.#next){this.#timer=setTimeout(poll,Math.max(1,Math.ceil(this.#next-now)));return;}this.#timer=undefined;this.#next=nextSkippedDeadline(this.#next,now,this.#period);this.#resolve=undefined;resolve();};poll();});
  }
  close():void{this.#closed=true;if(this.#timer)clearTimeout(this.#timer);this.#timer=undefined;this.#resolve?.();this.#resolve=undefined;}
}
