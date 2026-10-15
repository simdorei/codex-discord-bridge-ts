import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {registeredRemoteFileFailure,type RemoteFileFailure} from './files/error.ts';

type FileFailure=Readonly<{kind:'File';error:RemoteFileFailure}>;
type Diagnostic<K extends string>=Readonly<{kind:K;diagnostic:string}>;
export type RemoteCheckpointFailureInput=FileFailure|Readonly<{kind:'Invalid';value:string}>|Diagnostic<'Json'|'Base64'>;
export type RemoteCodeFailureInput=FileFailure|Readonly<{kind:'Cancelled'}>;
export type RemoteCommandFailureInput=FileFailure|Readonly<{kind:'Manifest';path:string;reason:string}>|Readonly<{kind:'Rejected';commandId:string;reason:string}>|Diagnostic<'Process'>;
export type RemoteGitFailureInput=FileFailure|Diagnostic<'Process'>|Readonly<{kind:'Failed';reason:string}>|Readonly<{kind:'TimedOut'|'Cancelled'}>;
export type RemoteImageFailureInput=FileFailure|Readonly<{kind:'Checkpoint';error:RemoteOperationFailure}>|Readonly<{kind:'Invalid';path:string;reason:string}>|Readonly<{kind:'Network';reason:string}>|Readonly<{kind:'Cancelled'|'TimedOut'}>;
export type RemoteTerminalFailureInput=
 | Readonly<{kind:'EmptySession'|'InvalidRoot'|'Closed'|'ForeignTerminal'|'ActiveCommand'|'Cancelled'|'MissingExecutableOrDirectory'|'CloseTimeout'|'UnsupportedRequest'}>
 | Readonly<{kind:'ShellUnavailable';shell:'auto'|'powershell'|'cmd'|'sh'|'bash'}>
 | Readonly<{kind:'Deadline';failure:'Expired'|'Cancelled'}>
 | Diagnostic<'Window'|'Process'|'Io'>;
export type RemoteOperationFailureInput=
 | Readonly<{family:'checkpoint';failure:RemoteCheckpointFailureInput}>
 | Readonly<{family:'code';failure:RemoteCodeFailureInput}>
 | Readonly<{family:'command';failure:RemoteCommandFailureInput}>
 | Readonly<{family:'git';failure:RemoteGitFailureInput}>
 | Readonly<{family:'image';failure:RemoteImageFailureInput}>
 | Readonly<{family:'terminal';failure:RemoteTerminalFailureInput}>;
export type RemoteOperationFailureFamily=RemoteOperationFailureInput['family'];
export interface RemoteOperationFailureDetails {readonly family:RemoteOperationFailureFamily;readonly code:string;readonly message:string;readonly cancelled:boolean;}
const failures=new WeakMap<object,RemoteOperationFailureDetails>();
const fileCodes=Object.freeze({UnsafePath:'unsafeprojectpath',UnsafePattern:'unsafeprojectpath',Size:'projectfilesize',Encoding:'projectfileencoding',Conflict:'fileconflict',Limit:'projectfilelimit',Io:'projectfile'});
const terminalMessages=Object.freeze({EmptySession:'session_id must not be empty',InvalidRoot:'terminal root is not a directory',Closed:'terminal session is closed',ForeignTerminal:'terminal does not belong to this session',ActiveCommand:'terminal already has an active command',Cancelled:'terminal execution was cancelled',MissingExecutableOrDirectory:'terminal executable or directory was not found',CloseTimeout:'terminal process trees did not stop before close timed out',UnsupportedRequest:'terminal window operation is not an execution request'});
function bounded(value:unknown):string{requireDiscordText(value);if(value.length>65536||Buffer.byteLength(value)>65536)throw new RangeError('Remote operation diagnostic exceeds byte limit');return value;}
function field(value:unknown,key:string):string{return bounded(own(value,key));}
function invalid():never{throw new TypeError('Invalid typed remote operation failure');}
function file(value:unknown):Readonly<{code:string;message:string;cancelled:false}>{const failure=registeredRemoteFileFailure(own(value,'error'));if(failure===null)return invalid();return {code:fileCodes[failure.kind],message:failure.message,cancelled:false};}
function capture(input:RemoteOperationFailureInput):RemoteOperationFailureDetails{
 const family=own(input,'family'),failure=own(input,'failure'),kind=own(failure,'kind');let code:string,message:string,cancelled=false;
 switch(family){
  case 'checkpoint':
   if(kind==='File')return Object.freeze({family,...file(failure)});
   code='projectcheckpoint';if(kind==='Invalid')message=`${field(failure,'value')}: invalid checkpoint record`;else if(kind==='Json'||kind==='Base64')message=field(failure,'diagnostic');else return invalid();break;
  case 'code':
   if(kind==='File')return Object.freeze({family,...file(failure)});
   if(kind!=='Cancelled')return invalid();code='request_cancelled';message='';cancelled=true;break;
  case 'command':
   code='projectcommand';
   if(kind==='File')message=file(failure).message;
   else if(kind==='Manifest')message=`${field(failure,'path')}: ${field(failure,'reason')}`;
   else if(kind==='Rejected')message=`${field(failure,'commandId')}: ${field(failure,'reason')}`;
   else if(kind==='Process')message=field(failure,'diagnostic');else return invalid();break;
  case 'git':
   if(kind==='File')return Object.freeze({family,...file(failure)});
   code='projectgit';
   if(kind==='Process')message=field(failure,'diagnostic');
   else if(kind==='Failed')message=`<git>: ${field(failure,'reason')}`;
   else if(kind==='TimedOut')message='<git>: Git command timed out';
   else if(kind==='Cancelled')message='<git>: Git command was cancelled';else return invalid();break;
  case 'image':{
   if(kind==='File')return Object.freeze({family,...file(failure)});
   if(kind==='Checkpoint'){const nested=captureRemoteOperationFailure(own(failure,'error'));if(nested===null||nested.family!=='checkpoint')return invalid();return Object.freeze({...nested,family});}
   code='projectimage';
   if(kind==='Invalid')message=`${field(failure,'path')}: ${field(failure,'reason')}`;
   else if(kind==='Network')message=`<image-url>: ${field(failure,'reason')}`;
   else if(kind==='Cancelled'){code='request_cancelled';message='';cancelled=true;}
   else if(kind==='TimedOut')message='image request expired before it completed';else return invalid();break;
  }
  case 'terminal':{
   code='terminal_execution';
   if(typeof kind==='string'&&Object.hasOwn(terminalMessages,kind))message=terminalMessages[kind as keyof typeof terminalMessages];
   else if(kind==='ShellUnavailable'){const shell=own(failure,'shell');const names={auto:'Auto',powershell:'Powershell',cmd:'Cmd',sh:'Sh',bash:'Bash'} as const;if(typeof shell!=='string'||!Object.hasOwn(names,shell))return invalid();message=`requested terminal shell is unavailable: ${names[shell as keyof typeof names]}`;}
   else if(kind==='Deadline'){const deadline=own(failure,'failure');if(deadline==='Expired')message='The local project request expired before execution.';else if(deadline==='Cancelled')message='The local project request was cancelled with its bridge connection.';else return invalid();}
   else if(kind==='Window'||kind==='Process')message=field(failure,'diagnostic');
   else if(kind==='Io')message=`terminal path could not be resolved: ${field(failure,'diagnostic')}`;else return invalid();break;
  }
  default:return invalid();
 }
 return Object.freeze({family,code,message:bounded(message),cancelled});
}
/** Validated source diagnostic, NOT proof of settlement, rollback or no effect.
 * Raw platform/serde/process diagnostic text must still pass the central worker
 * redaction boundary. Inputs are captured through own data fields only. */
export class RemoteOperationFailure {
 readonly #identity=true;
 constructor(input:RemoteOperationFailureInput){failures.set(this,capture(input));Object.freeze(this);}
}
/** Identity lookup only: copies, proxies, foreign exceptions and forged
 * prototypes are never inspected or given typed failure semantics. */
export function captureRemoteOperationFailure(value:unknown):RemoteOperationFailureDetails|null{return value!==null&&typeof value==='object'?failures.get(value)??null:null;}
Object.freeze(RemoteOperationFailure.prototype);
