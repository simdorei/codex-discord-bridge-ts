import {AdmittedRecoverExecutor} from '../action-executor/recover-action.ts';
import {runtimePluginPaths} from '../../pro/plugin-paths.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {RuntimePaths} from '../runtime-paths/resolve.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {AdmissionGate} from '../../admission/drain-gate.ts';
import {BridgeState} from '../bridge-state.ts';
import {RuntimeCommandExecutor,type RuntimeExecutorDependencies} from '../action-executor/command-executor.ts';
import {buildRecoveredRuntimeQueue} from './queue-bootstrap.ts';
import {ProPromptRuntime,type ProRemoteConnection} from '../../pro/runtime.ts';
import type {ProRuntimeDiagnostic} from '../../pro/preflight.ts';
type BusinessOptions=Pick<RuntimeExecutorDependencies,'render'|'preparePrompt'|'mirror'|'reportNewAttempt'|'resumeTimeoutMs'>;
export interface RuntimeExecutorBootstrapOptions extends BusinessOptions{
 readonly recovery?:AdmittedRecoverExecutor;
 readonly historyTimeoutMs:number;readonly reportPolicyFailure:(thread:string,error:unknown)=>void;readonly notifyDeliveryReady:()=>void;
}
type CommonOptions=Omit<RuntimeExecutorBootstrapOptions,'preparePrompt'>;
type Paths=Pick<RuntimePaths,'root'|'stateDb'|'mirrorDb'|'bridgeState'>;
export interface RuntimeProExecutorBootstrapOptions extends CommonOptions{
 readonly pro:Readonly<{executable:string;remote:ProRemoteConnection|null;report:(diagnostic:ProRuntimeDiagnostic)=>void}>;
}
function syncCallback(fn:unknown):asserts fn is (...args:any[])=>unknown{
 if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous executor bootstrap diagnostic');
}
function captureCommon(options:CommonOptions):CommonOptions{
 if(options===null||typeof options!=='object'||types.isProxy(options))throw new TypeError('Expected passive executor bootstrap options');
 const recovery=Object.hasOwn(options,'recovery')?own(options,'recovery') as AdmittedRecoverExecutor:undefined;
 if(recovery!==undefined&&(recovery===null||typeof recovery!=='object'||types.isProxy(recovery)))throw new TypeError('Expected owned recovery executor');
 const get=<K extends keyof CommonOptions>(key:K)=>own(options,key) as CommonOptions[K];
 const render=get('render'),mirror=get('mirror'),reportNewAttempt=get('reportNewAttempt'),reportPolicyFailure=get('reportPolicyFailure'),notifyDeliveryReady=get('notifyDeliveryReady'),resumeTimeoutMs=get('resumeTimeoutMs'),historyTimeoutMs=get('historyTimeoutMs');
 for(const timeout of [resumeTimeoutMs,historyTimeoutMs])if(typeof timeout!=='number'||!Number.isSafeInteger(timeout)||timeout<0||timeout>2147483647)throw new RangeError('Expected explicit supported executor timeout');
 for(const fn of [render,reportNewAttempt,reportPolicyFailure,notifyDeliveryReady])syncCallback(fn);
 let pinnedMirror:RuntimeExecutorDependencies['mirror']=null;
 if(mirror!==null){const link=own(mirror,'linkNewThread');if(typeof link!=='function'||types.isProxy(link)||types.isGeneratorFunction(link))throw new TypeError('Expected explicit mirror link');pinnedMirror=Object.freeze({linkNewThread:(...args:Parameters<NonNullable<typeof mirror>['linkNewThread']>)=>Reflect.apply(link,mirror,args)});}
 return Object.freeze({render,mirror:pinnedMirror,reportNewAttempt,reportPolicyFailure,notifyDeliveryReady,resumeTimeoutMs,historyTimeoutMs,...(recovery===undefined?{}:{recovery})});
}
/** Pure capture before any earlier asynchronous startup stages. */
export function captureRuntimeExecutorOptions(options:RuntimeExecutorBootstrapOptions):RuntimeExecutorBootstrapOptions{
 const common=captureCommon(options),preparePrompt=own(options,'preparePrompt') as RuntimeExecutorBootstrapOptions['preparePrompt'];
 if(typeof preparePrompt!=='function'||types.isProxy(preparePrompt)||types.isGeneratorFunction(preparePrompt))throw new TypeError('Expected explicit prompt preprocessor');
 return Object.freeze({...common,preparePrompt});
}
export function captureRuntimeProExecutorOptions(options:RuntimeProExecutorBootstrapOptions):RuntimeProExecutorBootstrapOptions{
 const common=captureCommon(options),pro=own(options,'pro'),executable=own(pro,'executable'),report=own(pro,'report'),raw=own(pro,'remote');requireDiscordText(executable);if(executable===''||executable.includes('\0'))throw new TypeError('Expected Pro executable');syncCallback(report);
 let remote:ProRemoteConnection|null=null;
 if(raw!==null){const deviceId=own(raw,'deviceId'),connected=own(raw,'isConnected');requireDiscordText(deviceId);if(deviceId==='')throw new TypeError('Expected Pro device identity');syncCallback(connected);remote=Object.freeze({deviceId,isConnected:connected as ()=>boolean});}
 return Object.freeze({...common,pro:Object.freeze({executable,report:report as (d:ProRuntimeDiagnostic)=>void,remote})});
}
type Prepared={readonly preparePrompt:RuntimeExecutorBootstrapOptions['preparePrompt'];readonly pro:ProPromptRuntime|null};
/** Exact-ID source build_executor. Caller owns resident and guard/drain lifetime.
 * Subscriptions precede recovery; preprocessor capture follows stabilization and
 * precedes intake. Success transfers exact receivers, failure releases them.
 * Platform controllers are installed by the application composition. No gateway,
 * remote agent or browser starts here. */
async function build(paths:Paths,server:PortableResidentLifecycle,admission:AdmissionGate,options:CommonOptions,capture:(root:string,state:string)=>Promise<Prepared>){
 const root=own(paths,'root'),stateDb=own(paths,'stateDb'),mirrorDb=own(paths,'mirrorDb'),bridgePath=own(paths,'bridgeState');for(const v of [root,stateDb,mirrorDb,bridgePath])requireDiscordText(v as string);
 const {render,mirror,reportNewAttempt,reportPolicyFailure,notifyDeliveryReady,resumeTimeoutMs,historyTimeoutMs}=options;
 if(options.recovery!==undefined)AdmittedRecoverExecutor.prototype.requireDatabase.call(options.recovery,mirrorDb as string);
 const completionReceiver=PortableResidentLifecycle.prototype.subscribeNotifications.call(server);
 let serverRequestReceiver:ReturnType<PortableResidentLifecycle['subscribeServerRequests']>|undefined;let transferred=false;
 try{
  serverRequestReceiver=PortableResidentLifecycle.prototype.subscribeServerRequests.call(server);
  const plugin=await runtimePluginPaths(root as string);
  const recovered=await buildRecoveredRuntimeQueue(mirrorDb as string,server,admission,render,reportPolicyFailure,notifyDeliveryReady,{resumeTimeoutMs,historyTimeoutMs,proSkillPath:plugin.proSkill});
  const prepared=await capture(root as string,stateDb as string);
  const bridge=new BridgeState(bridgePath as string),executor=new RuntimeCommandExecutor({paths:{state:stateDb as string,mirror:mirrorDb as string,bridge:bridgePath as string},bridge,server,backend:recovered.backend,queue:recovered.queue,render,preparePrompt:prepared.preparePrompt,mirror,reportNewAttempt,resumeTimeoutMs});
  if(options.recovery!==undefined)RuntimeCommandExecutor.prototype.configureRecovery.call(executor,options.recovery);
  const intakes=await RuntimeCommandExecutor.prototype.recoverPromptIntakesOnStartup.call(executor),requests=serverRequestReceiver;
  const disposeReceivers=()=>{completionReceiver.dispose();requests.dispose();};
  const result=Object.freeze({...recovered,bridge,executor,intakes,pro:prepared.pro,completionReceiver,serverRequestReceiver:requests,disposeReceivers});transferred=true;return result;
 }finally{if(!transferred){completionReceiver.dispose();serverRequestReceiver?.dispose();}}
}
export async function buildRuntimeCommandExecutor(paths:Paths,server:PortableResidentLifecycle,admission:AdmissionGate,options:RuntimeExecutorBootstrapOptions){
 const captured=captureRuntimeExecutorOptions(options);return build(paths,server,admission,captured,async()=>({preparePrompt:captured.preparePrompt,pro:null}));
}
/** Production Pro path uses actual inventory/fingerprint/manifest/project adapters.
 * An absent/disconnected remote remains a public held error for !pro, never raw
 * prompt fallback. The gateway readiness port is explicit, not authentication proof. */
export async function buildRuntimeProCommandExecutor(paths:Paths,server:PortableResidentLifecycle,admission:AdmissionGate,options:RuntimeProExecutorBootstrapOptions){
 const captured=captureRuntimeProExecutorOptions(options);
 return build(paths,server,admission,captured,async(root,stateDatabase)=>{
  const pro=await ProPromptRuntime.capture({root,stateDatabase,executable:captured.pro.executable,remote:captured.pro.remote,report:captured.pro.report,render:captured.render,server});
  return {pro,preparePrompt:(raw,thread,signal)=>ProPromptRuntime.prototype.prepare.call(pro,raw,thread,signal)};
 });
}
