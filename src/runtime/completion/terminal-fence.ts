import {types} from "node:util";
export interface TerminalFenceSubscription{changed(signal?:AbortSignal):Promise<bigint>;dispose():void}
export class TerminalFenceSubscriptionClosedError extends Error{constructor(){super("Terminal fence subscription is closed");this.name="TerminalFenceSubscriptionClosedError";}}
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed terminal identity");}
function u64(value:unknown):asserts value is bigint{if(typeof value!=="bigint"||value<0n||value>=(1n<<64n))throw new TypeError("Expected u64 terminal generation/version");}
const key=(generation:bigint,thread:string,turn:string)=>JSON.stringify([generation.toString(),thread,turn]);
/** One synchronous JS execution context; no cross-thread mutex/poisoning equivalence.
 * Terminal notification and retention version publish together, before any I/O. */
export class TerminalFence{
  readonly #stopped=new Map<string,{generation:bigint;thread:string;turn:string}>();#version=0n;
  readonly #subscribers=new Set<symbol>();readonly #waiters=new Map<symbol,()=>void>();
  get retentionVersion():bigint{return this.#version;}
  get pendingSubscribers():number{return this.#subscribers.size;}
  stop(generation:bigint,thread:string,turn:string):void{
    u64(generation);text(thread);text(turn);this.#stopped.set(key(generation,thread,turn),{generation,thread,turn});this.#version=(this.#version+1n)&((1n<<64n)-1n);
    for(const wake of this.#waiters.values())wake();
  }
  stopped(generation:bigint,thread:string,turn:string):boolean{u64(generation);text(thread);text(turn);return this.#stopped.has(key(generation,thread,turn));}
  retain(generation:bigint,jobs:readonly {readonly targetThreadId:string;readonly turnId:string|null}[],observedVersion:bigint):void{
    u64(generation);u64(observedVersion);if(this.#version!==observedVersion)return;
    const retained=new Set<string>();
    for(const job of jobs){
      if(job===null||typeof job!=="object"||types.isProxy(job))throw new TypeError("Expected typed queue snapshot");
      const field=(name:string)=>{const d=Object.getOwnPropertyDescriptor(job,name);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own queue snapshot field");return d.value as unknown;};
      const thread=field("targetThreadId"),turn=field("turnId");text(thread);if(turn!==null){text(turn);retained.add(key(generation,thread,turn));}
    }
    for(const id of this.#stopped.keys())if(!retained.has(id))this.#stopped.delete(id);
  }
  subscribe():TerminalFenceSubscription{
    const id=Symbol(),owner=this;this.#subscribers.add(id);let seen=this.#version,closed=false,busy=false,cancel:(()=>void)|null=null;
    return Object.freeze({
      async changed(signal?:AbortSignal):Promise<bigint>{
        if(closed)throw new TerminalFenceSubscriptionClosedError();if(busy)throw new TypeError("Only one pending changed call per subscription");if(signal?.aborted)throw signal.reason;
        busy=true;let abort:(()=>void)|undefined;
        try{
          if(seen===owner.#version)await new Promise<void>((resolve,reject)=>{
            owner.#waiters.set(id,resolve);cancel=()=>reject(new TerminalFenceSubscriptionClosedError());
            if(signal!==undefined){abort=()=>reject(signal.reason);signal.addEventListener("abort",abort,{once:true});}
          });
          if(closed)throw new TerminalFenceSubscriptionClosedError();if(signal?.aborted)throw signal.reason;
          seen=owner.#version;return seen;
        }finally{owner.#waiters.delete(id);cancel=null;busy=false;if(abort!==undefined)signal!.removeEventListener("abort",abort);}
      },
      dispose():void{if(closed)return;closed=true;owner.#subscribers.delete(id);owner.#waiters.delete(id);cancel?.();},
    });
  }
}
