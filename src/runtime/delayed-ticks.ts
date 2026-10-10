export interface TickSource {wait():Promise<void>;close():void}
/** One pending tick at most. A late consumer starts the next interval from consumption,
 * so long work does not cause a catch-up burst or accumulate queued timer callbacks. */
export class DelayedTicks implements TickSource{
  readonly #period:number;#timer:ReturnType<typeof setTimeout>|undefined;#waiting:(()=>void)|undefined;#pending=false;#closed=false;
  constructor(periodMilliseconds:number){if(!Number.isFinite(periodMilliseconds)||periodMilliseconds<=0)throw new TypeError("Expected positive finite tick interval");this.#period=periodMilliseconds;this.#arm();}
  #arm():void{this.#timer=setTimeout(()=>{this.#timer=undefined;if(this.#closed)return;if(this.#waiting){const resolve=this.#waiting;this.#waiting=undefined;this.#arm();resolve();}else this.#pending=true;},this.#period);}
  wait():Promise<void>{
    if(this.#closed)return Promise.resolve();
    if(this.#waiting!==undefined)throw new Error("A tick waiter is already active");
    if(this.#pending){this.#pending=false;this.#arm();return Promise.resolve();}
    return new Promise(resolve=>{this.#waiting=resolve;});
  }
  close():void{this.#closed=true;clearTimeout(this.#timer);this.#timer=undefined;this.#pending=false;this.#waiting?.();this.#waiting=undefined;}
}
