import {serdeField} from '../../app-server/value.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {diagnosticReport,queueDiagnosticReport,type DiagnosticPaths} from '../diagnostic-report.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
import {InvalidActionRequestError,MissingActionAppServerError} from './errors.ts';
const result=(text:string)=>snapshotActionResult({text,waitsForFinal:false,ui:null});
/** Connects existing bounded diagnostic workers and the owned restart supervisor.
 * It never invokes Windows host restart/force-restart scripts. Windows resource
 * measurement remains unqualified; Linux retains the source unavailable label. */
export class RuntimeServiceActions{
 readonly #paths:DiagnosticPaths;readonly #server:PortableResidentLifecycle|null;
 constructor(input:DiagnosticPaths,server:PortableResidentLifecycle|null){
  const paths=cloneOwnedSerdeValue(input);for(const key of ['state','mirror','bridge'] as const)requireDiscordText(serdeField(paths,key));this.#paths=paths as DiagnosticPaths;this.#server=server;Object.freeze(this);
 }
 #lifecycle(absent:string):string{return this.#server===null?absent:serializeSerdeValue(this.#server.lifecycleSnapshot());}
 async doctor(signal?:AbortSignal):Promise<ActionResult>{
  const text=await diagnosticReport(this.#paths,signal);signal?.throwIfAborted();return result(`${text}\napp_server: ${this.#lifecycle('미확인: app-server 연결 없음')}\nruntime_pid: ${process.pid}`);
 }
 async resources(signal?:AbortSignal):Promise<ActionResult>{
  signal?.throwIfAborted();if(process.platform==='win32')throw new InvalidActionRequestError('Windows native host resource measurement is not yet qualified');
  const lifecycle=this.#lifecycle('unavailable');if(this.#paths.state===''||/^\/+$/u.test(this.#paths.state))throw new InvalidActionRequestError('resource disk path has no parent');
  let runners:string;try{runners=await queueDiagnosticReport(this.#paths.mirror,signal);}catch(error){signal?.throwIfAborted();runners=`runner 조회 실패: ${error instanceof Error?error.message:'diagnostic read failed'}`;}
  signal?.throwIfAborted();return result(`TypeScript runtime resources\nruntime_pid: ${process.pid}\napp_server: ${lifecycle}\nHost resources: 조회 불가 · Windows 실측 API만 지원\n${runners}`);
 }
 async restartCodex(signal?:AbortSignal):Promise<ActionResult>{
  signal?.throwIfAborted();if(this.#server===null)throw new MissingActionAppServerError();
  const restarted=await this.#server.forceRestartIfQuiescent(signal);signal?.throwIfAborted();
  return result(restarted?'Resident Codex app-server restarted.':'Codex app-server restart is pending until active turns and approvals finish.');
 }
}
Object.freeze(RuntimeServiceActions.prototype);
