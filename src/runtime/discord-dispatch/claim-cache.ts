export interface InteractionClaim{commit():boolean;release():boolean}
export type InteractionClaimAttempt={readonly kind:'Claimed';readonly claim:InteractionClaim}|{readonly kind:'DuplicatePending'|'DuplicateCommitted'|'Saturated'};
const liveHandles=new WeakMap<object,()=>boolean>();
export function isPendingInteractionClaim(value:unknown):value is InteractionClaim{return value!==null&&typeof value==='object'&&(liveHandles.get(value)?.()??false);}
interface Token{readonly id:bigint;readonly generation:bigint}
interface Entry{readonly generation:bigint;state:'Pending'|'Committed'}
/** Process-local single-event-loop claim custody. Share this owner between
 * dispatchers. Pending claims never evict; committed claims are FIFO-evictable.
 * Explicit release in finally replaces Rust Drop. Not durable deduplication, not
 * cross-worker-thread synchronization, and not Rust mutex-poisoning emulation. */
export class InteractionClaimCache{
 readonly capacity:number;readonly #claims=new Map<bigint,Entry>();readonly #committed:Token[]=[];#head=0;#generation=1n;
 constructor(capacity=4096){if(new.target!==InteractionClaimCache)throw new TypeError('Expected exact interaction claim cache');if(!Number.isSafeInteger(capacity)||capacity<0)throw new TypeError('Expected supported usize capacity');this.capacity=Math.max(1,capacity);Object.freeze(this);}
 tryClaim(id:bigint):InteractionClaimAttempt{
  if(typeof id!=='bigint'||id<=0n||id>(1n<<64n)-1n)throw new TypeError('Expected nonzero u64 interaction ID');const prior=this.#claims.get(id);if(prior!==undefined)return Object.freeze({kind:prior.state==='Pending'?'DuplicatePending':'DuplicateCommitted'});
  while(this.#claims.size>=this.capacity){if(!this.#evict())return Object.freeze({kind:'Saturated'});}
  // Source u128 increment has build-dependent overflow behavior. Outside this
  // supported nonoverflow profile, fail closed instead of reusing a generation.
  if(this.#generation>=(1n<<128n)-1n)throw new RangeError('Interaction claim generation exhausted');
  const token=Object.freeze({id,generation:this.#generation++});this.#claims.set(id,{generation:token.generation,state:'Pending'});let active=true;
  const claim:InteractionClaim=Object.freeze({commit:()=>{if(!active)return false;const committed=this.#commit(token);active=false;if(!committed)this.#release(token);return committed;},release:()=>{if(!active)return false;active=false;return this.#release(token);}});
  liveHandles.set(claim,()=>active);return Object.freeze({kind:'Claimed',claim});
 }
 #commit(token:Token):boolean{const entry=this.#claims.get(token.id);if(entry===undefined||entry.generation!==token.generation||entry.state!=='Pending')return false;entry.state='Committed';this.#committed.push(token);return true;}
 #release(token:Token):boolean{const entry=this.#claims.get(token.id);if(entry===undefined||entry.generation!==token.generation||entry.state!=='Pending')return false;this.#claims.delete(token.id);return true;}
 #evict():boolean{while(this.#head<this.#committed.length){const token=this.#committed[this.#head++]!,entry=this.#claims.get(token.id);if(this.#head>=1024&&this.#head*2>=this.#committed.length){this.#committed.splice(0,this.#head);this.#head=0;}if(entry?.generation===token.generation&&entry.state==='Committed'){this.#claims.delete(token.id);return true;}}return false;}
 snapshot(){let pending=0;for(const entry of this.#claims.values())if(entry.state==='Pending')pending++;return Object.freeze({size:this.#claims.size,capacity:this.capacity,pending,committed:this.#claims.size-pending});}
}
Object.freeze(InteractionClaimCache.prototype);
