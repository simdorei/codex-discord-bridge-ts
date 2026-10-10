import {types} from 'node:util';
import {GatewayIngressLane,type IngressLaneReceiver} from '../../discord/gateway/lane.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
export type RuntimeWorkerResult={readonly ok:true}|{readonly ok:false;readonly error:unknown};
export type RuntimeWorkerJoin={readonly kind:'Returned';readonly result:RuntimeWorkerResult}|{readonly kind:'TaskFailure';readonly error:unknown;readonly cancelled:boolean};
/** Explicit sender lifetime replaces Rust Clone/Drop. The capacity-one exit lane
 * is advisory: simultaneous exits may be dropped, but actual joins retain every
 * outcome. Closing the root sender does not discard live worker senders. */
export class RuntimeWorkerExitChannel{
 readonly #lane=new GatewayIngressLane<string>(1);#senders=1;#rootClosed=false;#taken=false;
 receiver():IngressLaneReceiver<string>{if(this.#taken)throw new TypeError('Worker exit receiver already taken');this.#taken=true;return this.#lane.receiver();}
 acquire():{finish:(name:string,announce:boolean)=>void}{if(this.#rootClosed)throw new TypeError('Worker exit root sender closed');this.#senders++;let finished=false;return Object.freeze({finish:(name:string,announce:boolean)=>{if(finished)return;finished=true;if(announce)this.#lane.trySend(name);if(--this.#senders===0)this.#lane.close();}});}
 close():void{if(this.#rootClosed)return;this.#rootClosed=true;if(--this.#senders===0)this.#lane.close();}
}
const owners=new WeakSet<object>();
/** Actual Promise custody, not a timeout wrapper. Abort requests cooperative
 * cancellation; join resolves only after the actual callback and its finally
 * blocks settle. Node cannot forcibly drop an arbitrary future as Tokio can. */
export class RuntimeMonitoredWorker{
 readonly name:string;readonly #abort=new AbortController();readonly #reason=Object.freeze(new Error('Runtime worker cancelled'));readonly #join:Promise<RuntimeWorkerJoin>;#result:RuntimeWorkerJoin|undefined;
 constructor(name:string,notifier:RuntimeWorkerExitChannel,start:(signal:AbortSignal)=>Promise<RuntimeWorkerResult>){
  if(new.target!==RuntimeMonitoredWorker)throw new TypeError('Expected exact worker owner');if(typeof name!=='string'||/[\uD800-\uDFFF]/u.test(name))throw new TypeError('Expected worker name');if(typeof start!=='function'||types.isProxy(start)||types.isGeneratorFunction(start))throw new TypeError('Expected worker callback');
  const lease=RuntimeWorkerExitChannel.prototype.acquire.call(notifier);this.name=name;
  this.#join=Promise.resolve().then(async()=>{let entered=false;try{this.#abort.signal.throwIfAborted();entered=true;const work=start(this.#abort.signal);if(!types.isPromise(work))throw new TypeError('Worker callback must return Promise');const result=await work,ok=gatewayOwnField(result,'ok');if(ok!==true&&ok!==false)throw new TypeError('Expected worker result');const captured:RuntimeWorkerResult=ok?Object.freeze({ok:true}):Object.freeze({ok:false,error:gatewayOwnField(result,'error')});return Object.freeze({kind:'Returned' as const,result:captured});}catch(error){return Object.freeze({kind:'TaskFailure' as const,error,cancelled:this.#abort.signal.aborted&&error===this.#reason});}finally{lease.finish(name,entered);}}).then(result=>{this.#result=result;return result;});
  Object.freeze(this.#join);owners.add(this);Object.freeze(this);
 }
 abort():void{this.#abort.abort(this.#reason);}
 join():Promise<RuntimeWorkerJoin>{return this.#join;}
 peek():RuntimeWorkerJoin|undefined{return this.#result;}
}
Object.freeze(RuntimeMonitoredWorker.prototype);
export function isRuntimeMonitoredWorker(value:unknown):value is RuntimeMonitoredWorker{return value!==null&&typeof value==='object'&&owners.has(value);}
