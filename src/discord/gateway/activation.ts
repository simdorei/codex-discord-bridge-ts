export type ActivationWaitOutcome='Activated'|'Stopped';
export type ActivationStopOutcome='StoppedBeforeActivation'|'StoppedAfterActivation'|'AlreadyStopped';
export class GatewayActivationError extends Error{readonly kind:'IngressReceiversNotTaken'|'AlreadyActivated'|'Stopped';constructor(kind:'IngressReceiversNotTaken'|'AlreadyActivated'|'Stopped'){super(kind==='IngressReceiversNotTaken'?'Discord gateway ingress receivers must be taken before typed activation':kind==='AlreadyActivated'?'Discord gateway typed consumers have already been activated':'Discord gateway activation was stopped by shutdown');this.name='GatewayActivationError';this.kind=kind;}}
export class GatewayIngressReceiversError extends Error{constructor(){super('Discord gateway ingress receivers have already been taken');this.name='GatewayIngressReceiversError';}}
/** Owns the receiver transfer and paused/activated/stopped gate. The caller still
 * owns each returned run Promise and the actual shard/socket shutdown contract.
 * Taking receivers is not proof that consumers are running: activation is explicit. */
export class GatewayTypedActivation<R extends object>{
 #receivers:R|null;#state:'Paused'|'Activated'|'Stopped'='Paused';readonly #waiters=new Set<()=>void>();
 constructor(receivers:R){if(receivers===null||typeof receivers!=='object')throw new TypeError('Expected typed ingress receivers');this.#receivers=receivers;}
 get pendingWaiters():number{return this.#waiters.size;}
 takeReceivers():R{if(this.#receivers===null)throw new GatewayIngressReceiversError();const value=this.#receivers;this.#receivers=null;return value;}
 activate():void{if(this.#receivers!==null)throw new GatewayActivationError('IngressReceiversNotTaken');if(this.#state==='Activated')throw new GatewayActivationError('AlreadyActivated');if(this.#state==='Stopped')throw new GatewayActivationError('Stopped');this.#state='Activated';this.#notify();}
 stop():ActivationStopOutcome{const old=this.#state;this.#state='Stopped';if(old!=='Stopped')this.#notify();return old==='Paused'?'StoppedBeforeActivation':old==='Activated'?'StoppedAfterActivation':'AlreadyStopped';}
 #notify():void{for(const wake of [...this.#waiters])wake();}
 async wait(signal?:AbortSignal):Promise<ActivationWaitOutcome>{
  for(;;){signal?.throwIfAborted();if(this.#state!=='Paused')return this.#state;
   await new Promise<void>((resolve,reject)=>{const cleanup=()=>{this.#waiters.delete(wake);signal?.removeEventListener('abort',abort);};const wake=()=>{cleanup();resolve();};const abort=()=>{cleanup();reject(signal?.reason);};this.#waiters.add(wake);signal?.addEventListener('abort',abort,{once:true});if(this.#state!=='Paused')wake();});
  }
 }
 /** Stop that wins before a paused waiter resumes suppresses active work entirely. */
 async runAfterActivation(active:()=>Promise<void>,signal?:AbortSignal):Promise<void>{if(await this.wait(signal)==='Activated')await active();}
}
