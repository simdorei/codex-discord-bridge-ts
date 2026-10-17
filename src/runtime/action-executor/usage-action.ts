import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {rateLimits,usage} from '../../app-server/requests.ts';
import {MissingActionAppServerError} from './errors.ts';
import {formatUsage} from './usage-format.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
/** Two sequential, independent source observations. Each request captures the
 * current generation; this is not an atomic cross-response account snapshot. */
export class UsageAction {
 readonly #server:PortableResidentLifecycle|null;
 constructor(server:PortableResidentLifecycle|null){this.#server=server;Object.freeze(this);}
 async usage(days:number,signal?:AbortSignal):Promise<ActionResult>{
  if(!Number.isSafeInteger(days)||days<0||days>0xffffffff)throw new TypeError('Expected u32 usage days');
  signal?.throwIfAborted();const server=this.#server;if(server===null)throw new MissingActionAppServerError();
  const rates=await server.execute(rateLimits(),server.generation(),signal);signal?.throwIfAborted();
  const value=await server.execute(usage(),server.generation(),signal);signal?.throwIfAborted();
  const today=new Date().toISOString().slice(0,10);
  return snapshotActionResult({text:formatUsage(days,rates,value,today),waitsForFinal:false,ui:null});
 }
}
Object.freeze(UsageAction.prototype);
