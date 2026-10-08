export class GenerationWatchClosedError extends Error{constructor(){super("lifecycle watch is closed");this.name="GenerationWatchClosedError";}}
export interface GenerationWatchReceiver{
  borrow():bigint|null;borrowAndUpdate():bigint|null;changed(signal?:AbortSignal):Promise<void>;
  clone():GenerationWatchReceiver;dispose():void;
  /** Non-consuming revocation check; sender/receiver closure counts as changed. */
  hasChangedOrClosed():boolean;
}
interface Receiver{seen:bigint;disposed:boolean;busy:boolean;wake:(()=>void)|undefined}
function generation(value:bigint|null):void{if(value!==null&&(typeof value!=="bigint"||value<0n||value>=(1n<<64n)))throw new TypeError("Expected optional u64 generation");}
/** Required one-sender watch<Option<u64>> subset of pinned Tokio 1.53.1. Equal-value
 * replacement still notifies; values coalesce; cloning preserves the receiver cursor.
 * Explicit close/dispose replaces Drop. Publication version exhaustion fails closed
 * before the 64-bit native version would wrap; no generic sender-clone/borrow-lock API. */
export class GenerationWatch{
  #value:bigint|null;#version=0n;#closed=false;readonly #receivers=new Set<Receiver>();
  constructor(value:bigint|null=null){generation(value);this.#value=value;}
  get receiverCount():number{return this.#receivers.size;}
  get pendingWaiters():number{return [...this.#receivers].filter(r=>r.wake!==undefined).length;}
  replace(value:bigint|null):bigint|null{
    generation(value);if(this.#closed)throw new GenerationWatchClosedError();if(this.#version===(1n<<63n)-1n)throw new RangeError("Lifecycle watch version exhausted");
    const old=this.#value;this.#value=value;this.#version++;for(const receiver of this.#receivers)receiver.wake?.();return old;
  }
  close():void{if(this.#closed)return;this.#closed=true;for(const receiver of this.#receivers)receiver.wake?.();}
  subscribe():GenerationWatchReceiver{if(this.#closed)throw new GenerationWatchClosedError();return this.#receiver(this.#version);}
  #receiver(seen:bigint):GenerationWatchReceiver{
    const receiver:Receiver={seen,disposed:false,busy:false,wake:undefined};this.#receivers.add(receiver);
    const idle=()=>{if(receiver.disposed)throw new GenerationWatchClosedError();if(receiver.busy)throw new TypeError("Concurrent lifecycle receiver operation");};
    return Object.freeze({
      hasChangedOrClosed:()=>receiver.disposed||this.#closed||receiver.seen!==this.#version,
      borrow:()=>{idle();return this.#value;},
      borrowAndUpdate:()=>{idle();receiver.seen=this.#version;return this.#value;},
      clone:()=>{idle();return this.#receiver(receiver.seen);},
      changed:async(signal?:AbortSignal)=>{
        idle();receiver.busy=true;
        try{while(true){
          signal?.throwIfAborted();if(receiver.disposed)throw new GenerationWatchClosedError();
          if(receiver.seen!==this.#version){receiver.seen=this.#version;return;}
          if(this.#closed)throw new GenerationWatchClosedError();
          await new Promise<void>((resolve,reject)=>{
            const cleanup=()=>{receiver.wake=undefined;signal?.removeEventListener("abort",abort);};
            const abort=()=>{cleanup();reject(signal?.reason);};receiver.wake=()=>{cleanup();resolve();};signal?.addEventListener("abort",abort,{once:true});
          });
        }}finally{receiver.busy=false;}
      },
      dispose:()=>{if(receiver.disposed)return;receiver.disposed=true;this.#receivers.delete(receiver);receiver.wake?.();},
    });
  }
}
