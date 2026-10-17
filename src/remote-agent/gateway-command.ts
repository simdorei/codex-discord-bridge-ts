import {requestObject,object,text,integer,nullable,required,defaulted,length,validationError,jsonError} from './request-input.ts';
import {decodeProjectOperationObject,validateProjectOperation,type ProjectOperation} from './project-request.ts';
import {parseRemoteUtcDateTime,type RemoteUtcDateTime} from './datetime.ts';
import {RemoteProtocolError} from './handshake.ts';
import {asU64} from '../store/async-resolution-json-helpers.ts';
type Common={readonly request_id:string;readonly thread_id:string;readonly deadline_at:RemoteUtcDateTime};
type OptionalSession={readonly computer_session_id:string|null};
export type GatewayCommand=
 | Readonly<Common&OptionalSession&{type:'project_info'}>
 | Readonly<Common&OptionalSession&{type:'list_files';pattern:string;limit:bigint}>
 | Readonly<Common&OptionalSession&{type:'read_file';path:string;start_line:bigint;max_lines:bigint}>
 | Readonly<Common&OptionalSession&{type:'write_file';path:string;content:string;expected_sha256:string|null}>
 | Readonly<Common&OptionalSession&{type:'project_operation';operation:ProjectOperation}>
 | Readonly<Common&{type:'project_session';computer_session_id:string;computer_session_generation:bigint}>
 | Readonly<Common&{type:'device_session';computer_session_id:string;computer_session_generation:bigint;working_directory:string;expires_at:RemoteUtcDateTime}>;
const u16=integer(0n,65535n),u64=integer(0n,18446744073709551615n),optionalText=nullable(text);
function defaultDeadline(nowMs:number):RemoteUtcDateTime{
 if(!Number.isSafeInteger(nowMs))throw new RangeError('Invalid default deadline clock');
 const deadline=nowMs+60000,year=new Date(deadline).getUTCFullYear();if(!Number.isSafeInteger(deadline)||!Number.isFinite(year)||year< -262143||year>262142)throw new RangeError('Default deadline outside Chrono range');
 const seconds=BigInt(Math.floor(deadline/1000));return Object.freeze({seconds,nanosecond:(BigInt(deadline)-seconds*1000n)*1000000n});
}
function shape(v:Record<string,unknown>,extra:readonly string[]):void{
 const allowed=['type','request_id','thread_id','deadline_at','computer_session_id',...extra];if(Object.keys(v).some(key=>!allowed.includes(key)))jsonError('unknown gateway command field');
}
function decode(raw:string,maxBytes:number,nowMs:number):GatewayCommand{
 const v=requestObject(raw,maxBytes),received=asU64(Object.hasOwn(v,'protocol_version')?v.protocol_version:undefined);
 if(received!==undefined&&received!==10n)throw new RemoteProtocolError('UnsupportedVersion','',received);
 const type=required(v,'type',text);
 const date=(value:unknown):RemoteUtcDateTime=>{const s=text(value);try{return parseRemoteUtcDateTime(s,maxBytes);}catch(error){if(error instanceof SyntaxError)throw new RemoteProtocolError('Json','invalid UTC datetime',null,error);throw error;}};
 const common=():Common=>({request_id:required(v,'request_id',text),thread_id:required(v,'thread_id',text),deadline_at:Object.hasOwn(v,'deadline_at')?date(v.deadline_at):defaultDeadline(nowMs)});
 const session=()=>defaulted(v,'computer_session_id',optionalText,null);
 switch(type){
  case 'project_info':shape(v,[]);return Object.freeze({type,...common(),computer_session_id:session()});
  case 'list_files':shape(v,['pattern','limit']);return Object.freeze({type,...common(),computer_session_id:session(),pattern:required(v,'pattern',text),limit:required(v,'limit',u16)});
  case 'read_file':shape(v,['path','start_line','max_lines']);return Object.freeze({type,...common(),computer_session_id:session(),path:required(v,'path',text),start_line:required(v,'start_line',u64),max_lines:required(v,'max_lines',u16)});
  case 'write_file':shape(v,['path','content','expected_sha256']);return Object.freeze({type,...common(),computer_session_id:session(),path:required(v,'path',text),content:required(v,'content',text),expected_sha256:defaulted(v,'expected_sha256',optionalText,null)});
  case 'project_operation':shape(v,['operation']);return Object.freeze({type,...common(),computer_session_id:session(),operation:decodeProjectOperationObject(required(v,'operation',object))});
  case 'project_session':shape(v,['computer_session_generation']);return Object.freeze({type,...common(),computer_session_id:required(v,'computer_session_id',text),computer_session_generation:required(v,'computer_session_generation',u64)});
  case 'device_session':shape(v,['computer_session_generation','working_directory','expires_at']);return Object.freeze({type,...common(),computer_session_id:required(v,'computer_session_id',text),computer_session_generation:required(v,'computer_session_generation',u64),working_directory:required(v,'working_directory',text),expires_at:required(v,'expires_at',date)});
  default:return jsonError('unknown gateway command type');
 }
}
/** Exact command schema and validation ordering. Missing deadline uses now+60s
 * with the Node clock's millisecond resolution. Past deadlines remain valid data;
 * execution-budget enforcement belongs to the later dispatcher. */
export function parseGatewayCommand(raw:string,maxBytes:number,nowMs=Date.now()):GatewayCommand{
 const v=decode(raw,maxBytes,nowMs);
 if(v.computer_session_id!==null)length('computer_session_id',v.computer_session_id,16,64);
 const within=(field:string,value:bigint,min:bigint,max:bigint)=>{if(value<min||value>max)validationError(field,`must be between ${min} and ${max}`);};
 switch(v.type){
  case 'list_files':length('pattern',v.pattern,1,500);within('limit',v.limit,1n,500n);break;
  case 'read_file':length('path',v.path,1,1000);within('start_line',v.start_line,1n,18446744073709551615n);within('max_lines',v.max_lines,1n,500n);break;
  case 'write_file':length('path',v.path,1,1000);length('content',v.content,0,1048576);if(v.expected_sha256!==null)length('expected_sha256',v.expected_sha256,64,64);break;
  case 'project_operation':validateProjectOperation(v.operation);break;
  case 'project_session':within('computer_session_generation',v.computer_session_generation,1n,18446744073709551615n);break;
  case 'device_session':within('computer_session_generation',v.computer_session_generation,1n,18446744073709551615n);length('working_directory',v.working_directory,1,1000);break;
 }
 return v;
}
