import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {TargetLocks} from '../../core/keyed-locks.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serdeField} from '../../app-server/value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {BridgeState} from '../bridge-state.ts';
import type {CommandAction} from '../command-plan.ts';
import {snapshotActionResult,type ActionResult} from '../action-result.ts';
import {snapshotActionContext,snapshotRuntimeCommand} from './command-snapshot.ts';
import type {NewActionContext} from './new-journal.ts';
import {ActionExecutionError} from './action-error.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {ThreadListAction} from './thread-list.ts';
import {ThreadStatusAction} from './thread-status.ts';
import {ContextAction} from './context-action.ts';
import {UsageAction} from './usage-action.ts';
import {ControlTurnVerifier} from './control-turn.ts';
import {RunnerInspection,savedRequestMessage} from './runner-inspection.ts';
import {SettingsOptionsAction} from './settings-options.ts';
import {RuntimeServiceActions} from './service-actions.ts';
import type {DiagnosticPaths} from '../diagnostic-report.ts';
const immediate=(text:string)=>snapshotActionResult({text,waitsForFinal:false,ui:null});
/** Concrete first dispatcher slice. One selection owner and actual existing
 * actions, with raw errors preserved for the central processor error boundary.
 * Unsupported commands never fall through to another command or native method.
 * This is not the full message business adapter or runnable bridge bootstrap. */
export class BasicActionDispatcher{
 readonly #mirror:string;readonly #selection:ActionThreadSelection;readonly #list:ThreadListAction;readonly #status:ThreadStatusAction;readonly #context:ContextAction;readonly #usage:UsageAction;readonly #runners:RunnerInspection;readonly #options:SettingsOptionsAction;readonly #services:RuntimeServiceActions;
 constructor(input:DiagnosticPaths,bridge:BridgeState,server:PortableResidentLifecycle|null,locks:TargetLocks,render:(error:unknown)=>string,resumeTimeoutMs:number){
  const paths=cloneOwnedSerdeValue(input);for(const key of ['state','mirror','bridge'])requireDiscordText(serdeField(paths,key));
  const p=paths as DiagnosticPaths;this.#mirror=p.mirror;this.#selection=new ActionThreadSelection(p.state,p.mirror,bridge);
  this.#list=new ThreadListAction(p.state,bridge,server,render);this.#status=new ThreadStatusAction(this.#selection,server,render);this.#context=new ContextAction(p.state,this.#selection);this.#usage=new UsageAction(server);
  this.#runners=new RunnerInspection(p.mirror,this.#selection,new ControlTurnVerifier(p.mirror,server,bridge,locks));this.#options=new SettingsOptionsAction(this.#selection,server,resumeTimeoutMs);this.#services=new RuntimeServiceActions(p,server);Object.freeze(this);
 }
 async targetThreadId(channel:bigint,signal?:AbortSignal):Promise<string>{signal?.throwIfAborted();const target=await this.#selection.targetThreadId(channel);signal?.throwIfAborted();return target;}
 async execute(input:CommandAction,contextInput:NewActionContext,signal?:AbortSignal):Promise<ActionResult>{
  signal?.throwIfAborted();const action=snapshotRuntimeCommand(input),context=snapshotActionContext(contextInput),channel=context.channelId,user=context.userId;
  let result:ActionResult;
  if(typeof action==='string'){
   switch(action){
    case 'Where':result=immediate(await this.#selection.whereMessage(channel));break;
    case 'Identity':result=immediate(`Discord identity\nuser_id: ${user}\nchannel_id: ${channel}\nthread_id: ${await this.#selection.targetThreadId(channel)}`);break;
    case 'Runners':result=immediate(await this.#runners.runners(channel,user,signal));break;
    case 'Doctor':result=await this.#services.doctor(signal);break;
    case 'Resources':result=await this.#services.resources(signal);break;
    case 'RestartCodex':result=await this.#services.restartCodex(signal);break;
    default:throw new ActionExecutionError('Unsupported',action);
   }
  }else if('Use'in action)result=immediate(this.#selection.select(action.Use.reference));
  else if('List'in action)result=await this.#list.list(action.List.limit,false,signal);
  else if('ArchivedList'in action)result=await this.#list.list(action.ArchivedList.limit,true,signal);
  else if('Status'in action)result=await this.#status.status(channel,action.Status.reference,signal);
  else if('Context'in action)result=await this.#context.context(channel,action.Context.all_threads,action.Context.refresh,action.Context.limit,signal);
  else if('Usage'in action)result=await this.#usage.usage(Number(action.Usage.days),signal);
  else if('SavedRequest'in action)result=immediate(await savedRequestMessage(this.#mirror,channel,user,action.SavedRequest.request_id,signal));
  else if('SettingsOptions'in action)result=await this.#options.options(channel,action.SettingsOptions.reference,action.SettingsOptions.field,signal);
  else throw new ActionExecutionError('Unsupported',Object.keys(action)[0]!);
  signal?.throwIfAborted();return snapshotActionResult(result);
 }
}
Object.freeze(BasicActionDispatcher.prototype);
