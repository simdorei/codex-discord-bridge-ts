import {boolean,enumeration,integer,jsonError,length,count,identifier,nullable,object,requestObject,strings,text,validationError} from './request-input.ts';
import type {Decoder} from './request-input.ts';
import {outputRecord as record,outputArray as array} from './output-input.ts';
import {parseRemoteUtcDateTime} from './datetime.ts';
const u64=integer(0n,18446744073709551615n),i64=integer(-9223372036854775808n,9223372036854775807n),u32=integer(0n,4294967295n);
function defaults<T>(decode:Decoder<T>,values:Readonly<Record<string,unknown>>):Decoder<T>{
 return input=>{const source=object(input),copy:Record<string,unknown>=Object.create(null);for(const key of Object.keys(source))copy[key]=source[key];for(const key of Object.keys(values))if(!Object.hasOwn(copy,key))copy[key]=values[key];return decode(copy);};
}
const datetime:Decoder<ReturnType<typeof parseRemoteUtcDateTime>>=input=>{const value=text(input);try{return parseRemoteUtcDateTime(value,12000000);}catch{return jsonError('invalid terminal output datetime');}};
const executionReceipt=record({receipt_id:text,terminal_id:text,command_digest:text,shell:enumeration(['auto','powershell','cmd','sh','bash']),cwd_scope:enumeration(['project_root','project_relative','external_absolute']),exit_code:nullable(i64),stdout_bytes:u64,stderr_bytes:u64,duration_ms:u64,timed_out:boolean,cancelled:boolean,truncated:boolean},['exit_code']);
const window=defaults(record({terminal_window_id:text,window_id:u64,process_id:u64,shell:enumeration(['powershell','cmd']),cwd:text,title:text,running:boolean}),{running:true});
const rect=record({left:i64,top:i64,width:u64,height:u64});
const actionReceipt=defaults(record({receipt_id:text,terminal_window_id:text,observation_id:nullable(text),identity_digest:text,action:enumeration(['activate','type','keys','interrupt']),unicode_chars:u32,keys:strings,activated:boolean,completed_at:datetime},['observation_id']),{unicode_chars:0n,keys:Object.freeze([])});
const schemas={
 terminal_exec:record({terminal_id:text,process_id:u64,exit_code:nullable(i64),stdout:text,stderr:text,cwd:text,duration_ms:u64,timed_out:boolean,cancelled:boolean,truncated:boolean,receipt:executionReceipt},['exit_code']),
 terminal_window_open:record({window}),
 terminal_window_list:record({windows:array(window)}),
 terminal_window_close:defaults(record({terminal_window_id:text,closed:boolean}),{closed:true}),
 terminal_window_capture:defaults(record({window,observation_id:text,identity_digest:text,rect,media_type:enumeration(['image/png']),data_base64:text,captured_at:datetime}),{media_type:'image/png'}),
 terminal_window_action:record({window,receipt:actionReceipt}),
} as const;
export type RemoteTerminalOutput={[K in keyof typeof schemas]:Readonly<{kind:K}>&ReturnType<(typeof schemas)[K]>}[keyof typeof schemas];
function terminalId(value:string){identifier('terminal_id',value,/^term_[a-f0-9]{16}$/);}
function windowId(value:string){identifier('terminal_window_id',value,/^termwin_[a-f0-9]{16}$/);}
function observationId(value:string){identifier('observation_id',value,/^twobs_[a-f0-9]{16}$/);}
function sha(field:string,value:string){identifier(field,value,/^[a-f0-9]{64}$/);}
function validateWindow(value:ReturnType<typeof window>):void{
 windowId(value.terminal_window_id);
 if(value.window_id===0n||value.process_id===0n)validationError('window','window and process IDs must be positive');
 length('cwd',value.cwd,1,1000);length('title',value.title,1,500);
 if(!value.running)validationError('running','must be true');
}
function validateExecutionReceipt(value:ReturnType<typeof executionReceipt>):void{
 identifier('receipt_id',value.receipt_id,/^tr_[a-f0-9]{16}$/);terminalId(value.terminal_id);sha('command_digest',value.command_digest);
 if(value.timed_out&&value.cancelled)validationError('outcome','terminal execution cannot be timed out and cancelled');
 if(value.exit_code===null&&!(value.timed_out||value.cancelled))validationError('exit_code','terminal execution without an exit code needs a stop reason');
}
function validateActionReceipt(value:ReturnType<typeof actionReceipt>):void{
 identifier('receipt_id',value.receipt_id,/^twrcpt_[a-f0-9]{16}$/);windowId(value.terminal_window_id);
 if(value.observation_id!==null)observationId(value.observation_id);
 sha('identity_digest',value.identity_digest);
 if(value.unicode_chars>4096n)validationError('unicode_chars','must not exceed 4096');
 count('keys',value.keys.length,0,4);for(const key of value.keys)length('keys',key,1,20);
 let valid=false;
 switch(value.action){
  case 'activate':valid=value.observation_id===null&&value.unicode_chars===0n&&value.keys.length===0;break;
  case 'type':valid=value.observation_id!==null&&value.unicode_chars>0n&&value.keys.length===0;break;
  case 'keys':valid=value.observation_id!==null&&value.unicode_chars===0n&&value.keys.length>0;break;
  case 'interrupt':valid=value.observation_id!==null&&value.unicode_chars===0n&&value.keys.length===2&&value.keys[0]==='CTRL'&&value.keys[1]==='C';break;
 }
 if(!valid)validationError('action','terminal window action receipt fields are inconsistent');
}
/** Internal decoder accepts only a freshly parsed bounded JSON object. */
export function decodeTerminalOutputObject(input:Record<string,unknown>):RemoteTerminalOutput{
 if(!Object.hasOwn(input,'kind'))return jsonError('missing kind');const kind=text(input.kind);
 if(!Object.hasOwn(schemas,kind))return jsonError('unknown terminal output kind');
 const payload:Record<string,unknown>=Object.create(null);for(const key of Object.keys(input))if(key!=='kind')payload[key]=input[key];
 return Object.freeze({kind,...schemas[kind as keyof typeof schemas](payload)}) as RemoteTerminalOutput;
}
export function validateTerminalOutput(value:RemoteTerminalOutput):void{
 switch(value.kind){
  case 'terminal_exec':
   terminalId(value.terminal_id);if(value.process_id===0n)validationError('process_id','must be positive');
   length('stdout',value.stdout,0,1048576);length('stderr',value.stderr,0,1048576);length('cwd',value.cwd,1,1000);validateExecutionReceipt(value.receipt);
   if(value.receipt.terminal_id!==value.terminal_id||value.receipt.exit_code!==value.exit_code||value.receipt.duration_ms!==value.duration_ms||value.receipt.timed_out!==value.timed_out||value.receipt.cancelled!==value.cancelled||value.receipt.truncated!==value.truncated)validationError('receipt','terminal output and receipt fields must match');break;
  case 'terminal_window_open':validateWindow(value.window);break;
  case 'terminal_window_list':for(const item of value.windows)validateWindow(item);break;
  case 'terminal_window_close':windowId(value.terminal_window_id);if(!value.closed)validationError('closed','must be true');break;
  case 'terminal_window_capture':
   validateWindow(value.window);observationId(value.observation_id);sha('identity_digest',value.identity_digest);
   if(value.rect.width===0n||value.rect.height===0n)validationError('rect','dimensions must be positive');length('data_base64',value.data_base64,12,12000000);break;
  case 'terminal_window_action':validateWindow(value.window);validateActionReceipt(value.receipt);if(value.window.terminal_window_id!==value.receipt.terminal_window_id)validationError('receipt','terminal window receipt identity does not match output');break;
 }
}
export function parseTerminalOutput(raw:string,maxBytes:number):RemoteTerminalOutput{
 const result=decodeTerminalOutputObject(requestObject(raw,maxBytes));validateTerminalOutput(result);return result;
}
