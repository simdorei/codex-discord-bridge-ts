import {requestObject,required,text} from './request-input.ts';
import {parseCoreRequest,type CoreRequest} from './core-request.ts';
import {parseComputerRequest,type ComputerRequest} from './computer-request.ts';
import {parseTerminalRequest,type TerminalRequest} from './terminal-request.ts';
export type ProjectOperation=CoreRequest|ComputerRequest|TerminalRequest;
/** Complete operation-family routing. The initial discriminator parse and final
 * family decode are both bounded; large-frame callers must use a native owner.
 * This is not the enclosing GatewayCommand or session-authorization contract. */
export function parseProjectOperation(raw:string,maxBytes:number):ProjectOperation {
 const kind=required(requestObject(raw,maxBytes),'kind',text);
 if(kind.startsWith('terminal_'))return parseTerminalRequest(raw,maxBytes);
 if(kind.startsWith('computer_'))return parseComputerRequest(raw,maxBytes);
 return parseCoreRequest(raw,maxBytes);
}
/** Relative lifetime only. A validated DTO is required. No wall-clock deadline,
 * timer, cancellation, permission, retry or connection lifetime is created. */
export function projectRequestLifetimeSeconds(value:ProjectOperation):bigint {
 switch(value.kind){
  case 'command_run':case 'terminal_exec':return value.timeout_seconds+15n;
  case 'git_push':return 315n;
  case 'repo_status':case 'repo_diff':case 'git_commit':case 'project_status':return 135n;
  default:return 60n;
 }
}
