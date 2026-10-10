import {types} from "node:util";
export class BroadcastClosedError extends Error{constructor(){super("channel closed");this.name="BroadcastClosedError";}}
export class BroadcastLaggedError extends Error{readonly missed:bigint;constructor(missed:bigint){super(`channel lagged by ${missed}`);this.name="BroadcastLaggedError";this.missed=missed;}}
export type BroadcastPoll<T>={readonly kind:"Value";readonly value:T}|{readonly kind:"Empty"|"Closed"}|{readonly kind:"Lagged";readonly missed:bigint};
export interface BroadcastReceiver<T>{receive(signal?:AbortSignal):Promise<T>;tryReceive():BroadcastPoll<T>;dispose():void}
interface ReceiverState{cursor:bigint;disposed:boolean;busy:boolean;wake:(()=>void)|undefined}
interface Slot<T>{value:T;remaining:number}
/** Single owned sender for immutable DTOs. Explicit close/dispose replaces sender/receiver
 * Drop; AbortSignal cancels only receive. Payloads are shared immutable references, not
 * Rust Clone allocation parity. Root freezing is only a guard; the producer decoder
 * must establish deep immutable-data validity (not arbitrary-JS object validation). Fixed app-server capacities are 1000->1024 and 500->512.
 * Bounded profile supports capacities <= 2^20 and fails before u64 sequence rollover. */
export class BoundedBroadcast<T>{
  readonly capacity:number;readonly #slots=new Map<bigint,Slot<T>>();readonly #receivers=new Set<ReceiverState>();#tail=0n;#closed=false;
  constructor(capacity:number){if(!Number.isSafeInteger(capacity)||capacity<=0||capacity>1048576)throw new RangeError("Unsupported broadcast capacity");let actual=1;while(actual<capacity)actual*=2;this.capacity=actual;}
  get receiverCount():number{return this.#receivers.size;}
  get retainedCount():number{return this.#slots.size;}
  get pendingWaiters():number{return [...this.#receivers].filter(r=>r.wake!==undefined).length;}
  send(value:T):number{
    if(this.#closed)throw new BroadcastClosedError();const remaining=this.#receivers.size;if(remaining===0)return 0;
    if(typeof value==="function"||(value!==null&&typeof value==="object"&&(types.isProxy(value)||!Object.isFrozen(value))))throw new TypeError("Broadcast requires an owned immutable DTO");
    if(this.#tail===(1n<<64n)-1n)throw new RangeError("Broadcast sequence exhausted");const pos=this.#tail++;
    this.#slots.delete(pos-BigInt(this.capacity));this.#slots.set(pos,{value,remaining});
    for(const receiver of this.#receivers)receiver.wake?.();return remaining;
  }
  close():void{if(this.#closed)return;this.#closed=true;for(const receiver of this.#receivers)receiver.wake?.();}
  #poll(receiver:ReceiverState):BroadcastPoll<T>{
    if(receiver.disposed)return {kind:"Closed"};
    const oldest=this.#tail>BigInt(this.capacity)?this.#tail-BigInt(this.capacity):0n;
    if(receiver.cursor<oldest){const missed=oldest-receiver.cursor;receiver.cursor=oldest;return {kind:"Lagged",missed};}
    if(receiver.cursor<this.#tail){const pos=receiver.cursor++,slot=this.#slots.get(pos);if(slot===undefined)throw new Error("Broadcast retention invariant violated");if(--slot.remaining===0)this.#slots.delete(pos);return {kind:"Value",value:slot.value};}
    return {kind:this.#closed?"Closed":"Empty"};
  }
  subscribe():BroadcastReceiver<T>{
    if(this.#closed)throw new BroadcastClosedError();const receiver:ReceiverState={cursor:this.#tail,disposed:false,busy:false,wake:undefined};this.#receivers.add(receiver);
    return Object.freeze({
      tryReceive:()=>{if(receiver.busy)throw new TypeError("Concurrent receive is not allowed");return Object.freeze(this.#poll(receiver));},
      receive:async(signal?:AbortSignal)=>{
        if(receiver.busy)throw new TypeError("Concurrent receive is not allowed");receiver.busy=true;
        try{while(true){
          signal?.throwIfAborted();const value=this.#poll(receiver);
          if(value.kind==="Value")return value.value;if(value.kind==="Closed")throw new BroadcastClosedError();if(value.kind==="Lagged")throw new BroadcastLaggedError(value.missed);
          await new Promise<void>((resolve,reject)=>{
            const cleanup=()=>{receiver.wake=undefined;signal?.removeEventListener("abort",abort);};
            const abort=()=>{cleanup();reject(signal?.reason);};receiver.wake=()=>{cleanup();resolve();};signal?.addEventListener("abort",abort,{once:true});
          });
        }}finally{receiver.busy=false;}
      },
      dispose:()=>{if(receiver.disposed)return;receiver.disposed=true;this.#receivers.delete(receiver);for(const [pos,slot] of this.#slots){if(pos>=receiver.cursor&&--slot.remaining===0)this.#slots.delete(pos);}receiver.wake?.();},
    });
  }
}
