import {boolean,enumeration,integer,jsonError,length,object,requestObject,text,validationError} from './request-input.ts';
import type {Decoder} from './request-input.ts';
import {outputRecord as record,outputArray as array} from './output-input.ts';
import {decodeCoreOutputObject,validateCoreOutput} from './core-output.ts';
import type {RemoteCoreOutput} from './core-output.ts';
import {decodeComputerOutputObject,validateComputerOutput} from './computer-output.ts';
import type {RemoteComputerOutput} from './computer-output.ts';
import {decodeTerminalOutputObject,validateTerminalOutput} from './terminal-output.ts';
import type {RemoteTerminalOutput} from './terminal-output.ts';
import {parseRemoteUtcDateTime} from './datetime.ts';
import {RemoteProtocolError} from './handshake.ts';
export type RemoteProjectOutput=RemoteCoreOutput|RemoteComputerOutput|RemoteTerminalOutput;
const u64=integer(0n,18446744073709551615n);
const datetime:Decoder<ReturnType<typeof parseRemoteUtcDateTime>>=v=>{const s=text(v);try{return parseRemoteUtcDateTime(s,12000000);}catch{return jsonError('invalid bridge datetime');}};
const projectOutput:Decoder<RemoteProjectOutput>=v=>{
 const input=object(v);if(!Object.hasOwn(input,'kind'))return jsonError('missing output kind');const kind=text(input.kind);
 if(kind.startsWith('computer_'))return decodeComputerOutputObject(input);
 if(kind.startsWith('terminal_'))return decodeTerminalOutputObject(input);
 return decodeCoreOutputObject(input);
};
const schemas={
 hello:record({type:enumeration(['hello']),protocol_version:(v:unknown)=>v===10n?10n as const:jsonError('expected protocol 10 hello'),device_id:text}),
 project_upsert:record({type:enumeration(['project_upsert']),project_scope:text,binding_id:text,thread_id:text,project_name:text,expires_at:datetime}),
 project_info_result:record({type:enumeration(['project_info_result']),request_id:text,output:record({root:text,thread_id:text})}),
 list_files_result:record({type:enumeration(['list_files_result']),request_id:text,output:record({files:array(record({path:text,size_bytes:u64})),truncated:boolean})}),
 read_file_result:record({type:enumeration(['read_file_result']),request_id:text,output:record({path:text,content:text,sha256:text,start_line:u64,end_line:u64,total_lines:u64,truncated:boolean,redacted:boolean})}),
 write_file_result:record({type:enumeration(['write_file_result']),request_id:text,output:record({path:text,sha256:text,bytes_written:u64,created:boolean})}),
 project_operation_result:record({type:enumeration(['project_operation_result']),request_id:text,output:projectOutput}),
 project_session_result:record({type:enumeration(['project_session_result']),request_id:text}),
 operation_error:record({type:enumeration(['operation_error']),request_id:text,error_code:text,message:text}),
} as const;
export type BridgeInboundMessage=ReturnType<(typeof schemas)[keyof typeof schemas]>;
export type BridgeResult=Exclude<BridgeInboundMessage,{type:'hello'|'project_upsert'}>;
function validateOutput(output:RemoteProjectOutput):void{
 switch(output.kind){
  case 'computer_windows':case 'computer_screenshot':case 'computer_action':case 'computer_stop':validateComputerOutput(output);break;
  case 'terminal_exec':case 'terminal_window_open':case 'terminal_window_list':case 'terminal_window_close':case 'terminal_window_capture':case 'terminal_window_action':validateTerminalOutput(output);break;
  default:validateCoreOutput(output);
 }
}
/** Full bridge-to-gateway structural decoder. It proves no execution authority,
 * does not redact content, and is not a wire serializer for internal datetime DTOs.
 * Production large-frame use still requires its native decoder integration. */
export function parseBridgeInboundMessage(raw:string,maxBytes:number):BridgeInboundMessage{
 const input=requestObject(raw,maxBytes);
 if(Object.hasOwn(input,'protocol_version')){
  const version=input.protocol_version;
  if(typeof version==='bigint'&&version>=0n&&version<=18446744073709551615n&&version!==10n)throw new RemoteProtocolError('UnsupportedVersion','',version);
 }
 if(!Object.hasOwn(input,'type'))return jsonError('missing type');const type=text(input.type);
 if(!Object.hasOwn(schemas,type))return jsonError('unknown bridge message type');
 const result=schemas[type as keyof typeof schemas](input);
 switch(result.type){
  case 'project_upsert':length('project_scope',result.project_scope,12,200);length('binding_id',result.binding_id,16,64);length('project_name',result.project_name,1,200);break;
  case 'read_file_result':if(result.output.start_line===0n)validationError('start_line','must be at least 1');break;
  case 'project_operation_result':validateOutput(result.output);break;
  case 'operation_error':length('error_code',result.error_code,1,100);length('message',result.message,1,1000);break;
 }
 return result;
}
