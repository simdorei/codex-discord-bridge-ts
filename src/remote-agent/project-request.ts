import {requestObject,required,text} from './request-input.ts';
import {decodeCoreRequestObject,validateCoreRequest,type CoreRequest} from './core-request.ts';
import {decodeComputerRequestObject,validateComputerRequest,type ComputerRequest} from './computer-request.ts';
import {decodeTerminalRequestObject,validateTerminalRequest,type TerminalRequest} from './terminal-request.ts';
export type ProjectOperation=CoreRequest|ComputerRequest|TerminalRequest;
/** Internal decode phase takes only a freshly parsed owned JSON object. */
export function decodeProjectOperationObject(value:Record<string,unknown>):ProjectOperation {
 const kind=required(value,'kind',text);
 if(kind.startsWith('terminal_'))return decodeTerminalRequestObject(value);
 if(kind.startsWith('computer_'))return decodeComputerRequestObject(value);
 return decodeCoreRequestObject(value);
}
/** Separated so a gateway can deserialize completely, then validate its session
 * before operation semantics, matching the original caller's error ordering. */
export function validateProjectOperation(value:ProjectOperation):ProjectOperation {
 if(value.kind.startsWith('terminal_'))return validateTerminalRequest(value as TerminalRequest);
 if(value.kind.startsWith('computer_'))return validateComputerRequest(value as ComputerRequest);
 return validateCoreRequest(value as CoreRequest);
}
export function parseProjectOperation(raw:string,maxBytes:number):ProjectOperation {
 return validateProjectOperation(decodeProjectOperationObject(requestObject(raw,maxBytes)));
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
