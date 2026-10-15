import {types} from 'node:util';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import type {GatewayCommand} from './gateway-command.ts';
import type {CoreRequest} from './core-request.ts';
import type {TerminalRequest} from './terminal-request.ts';
import type {BridgeResult} from './bridge-inbound.ts';
import {remoteCancelledResult} from './dispatch-contract.ts';
import {captureRemoteOperationFailure,type RemoteOperationFailure,type RemoteOperationFailureFamily} from './operation-failure.ts';
import {redactRemoteText} from './files/redaction.ts';

type OperationRequest=Extract<GatewayCommand,{type:'write_file'}>|CoreRequest|TerminalRequest;
type OperationError=Extract<BridgeResult,{type:'operation_error'}>;
declare const settledBrand:unique symbol;
export type RemoteSettledOperationFailure=Readonly<{[settledBrand]:true}>;
const outcomes=new WeakMap<object,{request:OperationRequest;failure:RemoteOperationFailure;used:boolean}>();
function accepts(request:OperationRequest,family:RemoteOperationFailureFamily):boolean{
 const kind=Object.getOwnPropertyDescriptor(request,'kind');
 const operation=kind===undefined?own(request,'type'):own(request,'kind');
 switch(operation){
  case 'write_file':case 'file_create':case 'file_apply_patch':case 'checkpoint_list':case 'checkpoint_show':case 'checkpoint_restore':return family==='checkpoint';
  case 'project_rules':case 'code_search':return family==='code';
  case 'command_list':case 'command_run':return family==='command';
  case 'repo_status':case 'repo_diff':case 'git_commit':case 'git_push':return family==='git';
  case 'save_image':case 'save_image_from_url':case 'list_images':case 'retrieve_image':return family==='image';
  // The backend owns the source's Git -> Code -> Command order for this composite.
  case 'project_status':return family==='git'||family==='code'||family==='command';
  case 'terminal_exec':case 'terminal_window_open':case 'terminal_window_list':case 'terminal_window_close':case 'terminal_window_capture':case 'terminal_window_activate':case 'terminal_window_type':case 'terminal_window_keys':case 'terminal_window_interrupt':return family==='terminal';
  default:return false;
 }
}
/** A trusted leaf's explicit settled failure return, bound to its exact request.
 * Issue only after all native work and effects are settled/observed. This does
 * not infer no effect from the diagnostic, prove native correctness or authorize
 * retries. Throwing this value is still an uncertain exception. */
export function settledRemoteOperationFailure(request:OperationRequest,failure:RemoteOperationFailure):RemoteSettledOperationFailure{
 if(request===null||typeof request!=='object'||types.isProxy(request)||!Object.isFrozen(request))throw new TypeError('Expected owned operation request');
 const details=captureRemoteOperationFailure(failure);if(details===null||!accepts(request,details.family))throw new TypeError('Failure family differs from operation');
 const value=Object.freeze(Object.create(null)) as RemoteSettledOperationFailure;outcomes.set(value,{request,failure,used:false});return value;
}
/** Pure diagnostic translation. Owner cancellation precedes source mapping;
 * terminal Deadline/Cancelled otherwise retain terminal_execution semantics.
 * Redaction failures use a fixed fallback, never a raw exception/diagnostic. */
export async function remoteOperationErrorResult(requestId:string,failure:RemoteOperationFailure,signal?:AbortSignal):Promise<OperationError>{
 requireDiscordText(requestId);if(Buffer.byteLength(requestId)>4096)throw new RangeError('Remote request identity exceeds byte limit');
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected abort signal');
 const details=captureRemoteOperationFailure(failure);if(details===null)throw new TypeError('Expected authentic typed operation failure');
 if(signal?.aborted||details.cancelled)return remoteCancelledResult(requestId);
 const fallback='The remote operation error could not be safely rendered.';let message:string;
 try{message=await redactRemoteText(details.message,signal);}catch{if(signal?.aborted)return remoteCancelledResult(requestId);message=fallback;}
 if(signal?.aborted)return remoteCancelledResult(requestId);if(message==='')message=fallback;
 let count=0,end=0;for(const char of message){if(count++===1000)break;end+=char.length;}message=message.slice(0,end);
 return Object.freeze({type:'operation_error',request_id:requestId,error_code:details.code,message});
}
/** Internal owner boundary. Consumes an authentic returned receipt once. Unknown
 * output is left to the existing DTO validator; no foreign fields are read. */
export async function takeRemoteOperationFailure(requestId:string,request:OperationRequest,value:unknown,signal:AbortSignal):Promise<OperationError|null>{
 const outcome=value!==null&&typeof value==='object'?outcomes.get(value):undefined;if(outcome===undefined)return null;
 if(outcome.used)throw new TypeError('Settled operation failure was already consumed');outcome.used=true;
 if(outcome.request!==request)throw new TypeError('Settled operation failure belongs to another request');
 return await remoteOperationErrorResult(requestId,outcome.failure,signal);
}
