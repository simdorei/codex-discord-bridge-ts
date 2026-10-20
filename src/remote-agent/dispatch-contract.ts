import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import type {GatewayCommand} from './gateway-command.ts';
import type {ProjectOperation} from './project-request.ts';
import type {BridgeResult} from './bridge-inbound.ts';
import type {RemoteUtcDateTime} from './datetime.ts';
import {requireDiscordText} from '../discord/text.ts';
export type RemoteCommandMeta=Readonly<{request_id:string;thread_id:string;deadline_at:RemoteUtcDateTime;computer_session_id:string|null}>;
export type RemoteSessionActivation=Readonly<{session_id:string;session_generation:bigint;computer_mode:'project'|'device'}>;
function commandType(command:GatewayCommand):GatewayCommand['type']{
 const type=own(command,'type');switch(type){case 'project_info':case 'list_files':case 'read_file':case 'write_file':case 'project_operation':case 'project_session':case 'device_session':return type;default:throw new TypeError('Unknown decoded gateway command');}
}
/** Internal leaf contract: requires an already decoded GatewayCommand. These
 * helpers do not reparse large content or grant authorization/session ownership.
 * Own-data access avoids activating fields if the typed boundary is violated. */
export function remoteCommandMeta(command:GatewayCommand):RemoteCommandMeta{
 commandType(command);
 return Object.freeze({request_id:own(command,'request_id') as string,thread_id:own(command,'thread_id') as string,deadline_at:own(command,'deadline_at') as RemoteUtcDateTime,computer_session_id:own(command,'computer_session_id') as string|null});
}
export function remoteSessionActivation(command:GatewayCommand):RemoteSessionActivation|null{
 const type=commandType(command);if(type!=='project_session'&&type!=='device_session')return null;
 return Object.freeze({session_id:own(command,'computer_session_id') as string,session_generation:own(command,'computer_session_generation') as bigint,computer_mode:type==='project_session'?'project':'device'});
}
function mutationOperation(kind:ProjectOperation['kind']):boolean{
 switch(kind){
  case 'project_rules':case 'project_status':case 'code_search':case 'command_list':case 'repo_status':case 'repo_diff':case 'list_images':case 'retrieve_image':case 'checkpoint_list':case 'checkpoint_show':case 'terminal_exec':return false;
  case 'file_apply_patch':case 'file_create':case 'command_run':case 'git_commit':case 'git_push':case 'save_image':case 'save_image_from_url':case 'checkpoint_restore':
  case 'computer_list_windows':case 'computer_stop':case 'computer_launch':case 'computer_activate':case 'computer_screenshot':case 'computer_click':case 'computer_drag':case 'computer_scroll':case 'computer_type_text':case 'computer_set_clipboard':case 'computer_press_keys':case 'computer_close':
  case 'terminal_window_open':case 'terminal_window_list':case 'terminal_window_close':case 'terminal_window_capture':case 'terminal_window_activate':case 'terminal_window_type':case 'terminal_window_keys':case 'terminal_window_interrupt':return true;
  default:{const exhaustive:never=kind;void exhaustive;throw new TypeError('Unknown decoded project operation');}
 }
}
/** Source replay-cache classification, not a permission or side-effect safety
 * classification. In particular terminal_exec is excluded while screenshots,
 * window listing and computer_stop are included, exactly as dispatcher/state. */
export function remoteCommandIsMutation(command:GatewayCommand):boolean{
 const type=commandType(command);if(type==='write_file')return true;if(type!=='project_operation')return false;
 return mutationOperation(own(own(command,'operation'),'kind') as ProjectOperation['kind']);
}
type OperationError=Extract<BridgeResult,{type:'operation_error'}>;
function error(requestId:string,code:string,message:string):OperationError{requireDiscordText(requestId);requireDiscordText(code);requireDiscordText(message);return Object.freeze({type:'operation_error',request_id:requestId,error_code:code,message});}
export function remoteBindingError(requestId:string,code:string):OperationError{return error(requestId,code,code==='binding_expired'?'The local project binding expired. Run !pro again.':'The Codex thread is not bound on this device.');}
export function remoteExpiredResult(requestId:string):OperationError{return error(requestId,'request_expired','The remote project request expired before it could run.');}
export function remoteCancelledResult(requestId:string):OperationError{return error(requestId,'request_cancelled','The remote project request was cancelled because the local bridge disconnected.');}
export function remoteSessionError(requestId:string,message:string):OperationError{return error(requestId,'computer_control',message);}
export function remoteRequestConflict(requestId:string):OperationError{return error(requestId,'request_id_conflict','The request ID was reused with different command content.');}
