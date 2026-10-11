import {join} from 'node:path';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {RuntimePaths} from '../runtime-paths/resolve.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {AdmissionGate} from '../../admission/drain-gate.ts';
import {BridgeState} from '../bridge-state.ts';
import {RuntimeCommandExecutor,type RuntimeExecutorDependencies} from '../action-executor/command-executor.ts';
import {buildRecoveredRuntimeQueue} from './queue-bootstrap.ts';
type BusinessOptions=Pick<RuntimeExecutorDependencies,'render'|'preparePrompt'|'mirror'|'reportNewAttempt'|'resumeTimeoutMs'>;
export interface RuntimeExecutorBootstrapOptions extends BusinessOptions{
 readonly historyTimeoutMs:number;
 readonly reportPolicyFailure:(thread:string,error:unknown)=>void;
 readonly notifyDeliveryReady:()=>void;
}
/** Source build_executor exact-ID branch. Borrowed resident and admission gate:
 * caller owns cleanup if this fails. Exclusive startup guard and completed
 * retirement are prerequisites; invoke before periodic/live intake workers.
 * Success transfers both bounded event receivers to the caller, which must pass
 * these exact receivers to workers and dispose them after joined shutdown. Failure
 * releases subscriptions while retaining the borrowed resident owner.
 * The preprocessing/mirror ports are explicit mandatory inputs, not fabricated
 * Pro support. BridgeState remains the existing synchronous owner. Unsupported
 * host/archive-delete/mirror-sync features stay explicit in the basic dispatcher. */
export async function buildRuntimeCommandExecutor(paths:Pick<RuntimePaths,'root'|'stateDb'|'mirrorDb'|'bridgeState'>,server:PortableResidentLifecycle,admission:AdmissionGate,options:RuntimeExecutorBootstrapOptions){
 const get=<K extends keyof RuntimeExecutorBootstrapOptions>(key:K)=>own(options,key) as RuntimeExecutorBootstrapOptions[K];
 const root=own(paths,'root'),stateDb=own(paths,'stateDb'),mirrorDb=own(paths,'mirrorDb'),bridgePath=own(paths,'bridgeState');for(const v of [root,stateDb,mirrorDb,bridgePath])requireDiscordText(v as string);
 const render=get('render'),preparePrompt=get('preparePrompt'),mirror=get('mirror'),reportNewAttempt=get('reportNewAttempt'),reportPolicyFailure=get('reportPolicyFailure'),notifyDeliveryReady=get('notifyDeliveryReady'),resumeTimeoutMs=get('resumeTimeoutMs'),historyTimeoutMs=get('historyTimeoutMs');
 for(const timeout of [resumeTimeoutMs,historyTimeoutMs])if(typeof timeout!=='number'||!Number.isSafeInteger(timeout)||timeout<0||timeout>2147483647)throw new RangeError('Expected explicit supported executor timeout');
 for(const fn of [render,reportNewAttempt,reportPolicyFailure,notifyDeliveryReady])if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous executor bootstrap diagnostic');
 if(typeof preparePrompt!=='function'||types.isProxy(preparePrompt)||types.isGeneratorFunction(preparePrompt))throw new TypeError('Expected explicit prompt preprocessor');
 // Pin mutable link objects before recovery awaits, using the existing contract.
 let pinnedMirror:RuntimeExecutorDependencies['mirror']=null;
 if(mirror!==null){const link=own(mirror,'linkNewThread');if(typeof link!=='function'||types.isProxy(link)||types.isGeneratorFunction(link))throw new TypeError('Expected explicit mirror link');pinnedMirror=Object.freeze({linkNewThread:(...args:Parameters<NonNullable<typeof mirror>['linkNewThread']>)=>Reflect.apply(link,mirror,args)});}
 // Source subscribes before queue/intake recovery: those awaits may produce
 // completion or approval events. Never resubscribe later and lose this prefix.
 const completionReceiver=PortableResidentLifecycle.prototype.subscribeNotifications.call(server);
 let serverRequestReceiver:ReturnType<PortableResidentLifecycle['subscribeServerRequests']>|undefined;
 let transferred=false;
 try{
  serverRequestReceiver=PortableResidentLifecycle.prototype.subscribeServerRequests.call(server);
 const recovered=await buildRecoveredRuntimeQueue(mirrorDb as string,server,admission,render,reportPolicyFailure,notifyDeliveryReady,{resumeTimeoutMs,historyTimeoutMs,proSkillPath:join(root as string,'plugins/codex-discord-remote/skills/ask-chatgpt-pro/SKILL.md')});
 const bridge=new BridgeState(bridgePath as string),executor=new RuntimeCommandExecutor({paths:{state:stateDb as string,mirror:mirrorDb as string,bridge:bridgePath as string},bridge,server,backend:recovered.backend,queue:recovered.queue,render,preparePrompt,mirror:pinnedMirror,reportNewAttempt,resumeTimeoutMs});
 const intakes=await RuntimeCommandExecutor.prototype.recoverPromptIntakesOnStartup.call(executor);
 const requests=serverRequestReceiver;
 const disposeReceivers=()=>{completionReceiver.dispose();requests.dispose();};
 const result=Object.freeze({...recovered,bridge,executor,intakes,completionReceiver,serverRequestReceiver:requests,disposeReceivers});
 transferred=true;return result;
 }finally{if(!transferred){completionReceiver.dispose();serverRequestReceiver?.dispose();}}
}
