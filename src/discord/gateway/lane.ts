export type IngressLanePoll<T>={readonly kind:'Value';readonly value:T}|{readonly kind:'Empty'|'Closed'};
export interface IngressLaneReceiver<T>{tryReceive():IngressLanePoll<T>;receive(signal?:AbortSignal):Promise<T|null>;close():void;dispose():void;readonly length:number}
/** Bounded single receiver lane. Sender never awaits: close rejects new sends but
 * drains queued items; dispose drops them. One cancelled wait consumes no item. */
export class GatewayIngressLane<T>{
 readonly capacity:number;readonly #items:T[]=[];#closed=false;#disposed=false;#busy=false;#taken=false;#wake:(()=>void)|undefined;
 constructor(capacity:number){if(!Number.isSafeInteger(capacity)||capacity<=0||capacity>1048576)throw new RangeError('Unsupported gateway lane capacity');this.capacity=capacity;}
 trySend(value:T):'Accepted'|'Full'|'Closed'{if(this.#closed)return 'Closed';if(this.#items.length>=this.capacity)return 'Full';this.#items.push(value);this.#wake?.();return 'Accepted';}
 #poll():IngressLanePoll<T>{if(this.#items.length!==0)return {kind:'Value',value:this.#items.shift()!};return {kind:this.#closed?'Closed':'Empty'};}
 close():void{if(this.#closed)return;this.#closed=true;this.#wake?.();}
 receiver():IngressLaneReceiver<T>{if(this.#taken)throw new TypeError('Gateway lane receiver already taken');this.#taken=true;const self=this;return Object.freeze({get length(){return self.#items.length;},tryReceive:()=>{if(this.#busy)throw new TypeError('Concurrent gateway lane receive');return Object.freeze(this.#poll());},receive:async(signal?:AbortSignal)=>{
  if(this.#busy)throw new TypeError('Concurrent gateway lane receive');this.#busy=true;
  try{for(;;){signal?.throwIfAborted();const value=this.#poll();if(value.kind==='Value')return value.value;if(value.kind==='Closed')return null;
   await new Promise<void>((resolve,reject)=>{const cleanup=()=>{this.#wake=undefined;signal?.removeEventListener('abort',abort);};const abort=()=>{cleanup();reject(signal?.reason);};this.#wake=()=>{cleanup();resolve();};signal?.addEventListener('abort',abort,{once:true});});
  }}finally{this.#busy=false;}
 },close:()=>this.close(),dispose:()=>{if(this.#disposed)return;this.#disposed=true;this.#items.length=0;this.close();this.#wake?.();}});}
}
