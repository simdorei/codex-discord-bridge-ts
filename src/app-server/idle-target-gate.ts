import {IdleObservationError} from "./notification-state.ts";
import {cloneIdleReleaseToken,pinIdleReleaseJournal,type IdleReleaseJournal,type IdleReleaseToken,type PinnedIdleReleaseJournal} from "./idle-release-journal.ts";
export interface TargetMutationPermit{preflight():void;release():void}
export interface TargetExclusivePermit{readonly thread:string;readonly journal:PinnedIdleReleaseJournal;requireHeld():void;release():void}
export type TargetMutationAdmission={readonly kind:"Ordinary";readonly permit:TargetMutationPermit}|{readonly kind:"Resubscribe";readonly permit:TargetExclusivePermit;readonly token:IdleReleaseToken};
const MAX_U64=(1n<<64n)-1n;
function u64(value:bigint):void{if(typeof value!=="bigint"||value<0n||value>MAX_U64)throw new TypeError("Expected u64 target gate value");}
function text(value:string):void{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed target gate text");}
export function nextObservationGapEpoch(current:bigint):bigint{u64(current);const next=current+1n+(current&1n);return next>MAX_U64?MAX_U64:next;}
/** Single-context idle target gate, source idle_release/gate.rs. Required durable journal
 * checks remain inside its synchronous critical section; callbacks must not reenter.
 * Explicit release replaces Rust Drop. This is not the queue's FIFO target mutex. */
export class IdleTargetGate{
  readonly #mutations=new Map<string|null,bigint>();readonly #exclusive=new Set<string>();#journal:PinnedIdleReleaseJournal|null=null;#gap=0n;#critical=false;
  #locked<T>(operation:()=>T):T{if(this.#critical)throw new TypeError("Idle target journal must not reenter its gate");this.#critical=true;try{return operation();}finally{this.#critical=false;}}
  install(journal:IdleReleaseJournal):void{this.#locked(()=>{if(this.#journal!==null||this.#mutations.size>0||this.#exclusive.size>0)throw new IdleObservationError("idle journal must be installed once before intake");this.#journal=pinIdleReleaseJournal(journal);});}
  journal():PinnedIdleReleaseJournal|null{return this.#locked(()=>this.#journal);}
  admit(owner:string,generation:bigint,target:string|null):TargetMutationAdmission{
    text(owner);u64(generation);if(target!==null)text(target);return this.#locked(()=>{
      if(target===null?this.#exclusive.size>0:this.#exclusive.has(target))throw new IdleObservationError("target subscription maintenance is in flight; request not sent");
      const journal=this.#journal;if(target!==null&&journal!==null){const token=journal.beforeMutation(owner,generation,target);if(token!==null){
        if(this.#mutations.has(null)||this.#mutations.has(target))throw new IdleObservationError("resubscription admission conflicted; durable hold retained");
        this.#exclusive.add(target);return Object.freeze({kind:"Resubscribe",permit:this.#exclusivePermit(target,journal),token});
      }}
      const count=this.#mutations.get(target)??0n;if(count===MAX_U64)throw new RangeError("Target mutation count exhausted");this.#mutations.set(target,count+1n);let released=false;
      const permit:TargetMutationPermit=Object.freeze({preflight:()=>this.#locked(()=>{if(released)throw new TypeError("Target mutation permit was released");if(this.#journal!==null&&target!==null)this.#journal.checkMutation(target);}),release:()=>{if(released)return;this.#locked(()=>{const count=this.#mutations.get(target);if(count===undefined||count===0n)throw new TypeError("Counted target mutation missing");if(count===1n)this.#mutations.delete(target);else this.#mutations.set(target,count-1n);released=true;});}});
      return Object.freeze({kind:"Ordinary",permit});
    });
  }
  reserve(input:IdleReleaseToken):TargetExclusivePermit{const token=cloneIdleReleaseToken(input);return this.#locked(()=>{
    const target=token.threadId;if(this.#mutations.has(null)||this.#mutations.has(target)||this.#exclusive.has(target))throw new IdleObservationError("idle release deferred: admitted target mutation");
    const journal=this.#journal;if(journal===null)throw new IdleObservationError("idle journal is not installed");journal.verify(token,token.state==="Candidate");this.#exclusive.add(target);return this.#exclusivePermit(target,journal);
  });}
  #exclusivePermit(thread:string,journal:PinnedIdleReleaseJournal):TargetExclusivePermit{
    let released=false;return Object.freeze({thread,journal,requireHeld:()=>this.#locked(()=>{if(released||!this.#exclusive.has(thread))throw new TypeError("Exclusive target permit was released");}),release:()=>{if(released)return;this.#locked(()=>{this.#exclusive.delete(thread);released=true;});}});
  }
  markGap():void{this.#gap=nextObservationGapEpoch(this.#gap);}
  holdUnattributedGap():void{this.#gap=MAX_U64;}
  observationsVerified():boolean{return (this.#gap&1n)===0n;}
  gapEpoch():bigint{return this.#gap;}
  clearGap(expected:bigint):boolean{u64(expected);if(expected===MAX_U64)return false;if((expected&1n)===0n)return this.#gap===expected;if(this.#gap!==expected)return false;this.#gap=expected+1n;return true;}
}
