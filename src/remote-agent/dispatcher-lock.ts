/** Private dispatcher lock. Its waiters are already charged to the enclosing
 * four-active command budget; it is not a worker pool or an admission queue. */
export class DispatcherLock {
 #held=false;#waiting:Array<{grant:()=>void;cancel:()=>void}>=[];
 acquire(signal:AbortSignal):Promise<()=>void>{
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
   const waiter={grant:()=>{signal.removeEventListener('abort',waiter.cancel);this.#held=true;let released=false;resolve(()=>{if(released)return;released=true;const next=this.#waiting.shift();if(next)next.grant();else this.#held=false;});},cancel:()=>{const at=this.#waiting.indexOf(waiter);if(at>=0)this.#waiting.splice(at,1);signal.removeEventListener('abort',waiter.cancel);reject(signal.reason);}};
   if(!this.#held){waiter.grant();return;}
   if(this.#waiting.length>=4){reject(new Error('Dispatcher lock capacity exceeded'));return;}
   this.#waiting.push(waiter);signal.addEventListener('abort',waiter.cancel,{once:true});if(signal.aborted)waiter.cancel();
  });
 }
}
