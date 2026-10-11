import {requestObject, text, boolean, integer, enumeration, nullable, strings, stringMap, required, defaulted, fields, length, count, identifier, validationError, jsonError, utf8Compare} from './request-input.ts';
export type TerminalShell = 'auto' | 'powershell' | 'cmd' | 'sh' | 'bash';
export type TerminalWindowShell = 'powershell' | 'cmd';
export type TerminalRequest =
 | Readonly<{kind:'terminal_exec';terminal_id:string|null;shell:TerminalShell;command:string;cwd:string|null;environment:Readonly<Record<string,string>>;timeout_seconds:bigint;cancel_previous:boolean}>
 | Readonly<{kind:'terminal_window_open';shell:TerminalWindowShell;cwd:string|null}>
 | Readonly<{kind:'terminal_window_list'}>
 | Readonly<{kind:'terminal_window_close'|'terminal_window_capture'|'terminal_window_activate';terminal_window_id:string}>
 | Readonly<{kind:'terminal_window_type';terminal_window_id:string;observation_id:string;text:string}>
 | Readonly<{kind:'terminal_window_keys';terminal_window_id:string;observation_id:string;keys:readonly string[]}>
 | Readonly<{kind:'terminal_window_interrupt';terminal_window_id:string;observation_id:string}>;
const shell = enumeration(['auto','powershell','cmd','sh','bash'] as const);
const windowShell = enumeration(['powershell','cmd'] as const);
const optionalText = nullable(text), u16 = integer(0n,65_535n);
/** Internal: input must be a freshly parsed, owned JSON object. */
export function decodeTerminalRequestObject(v:Record<string,unknown>):TerminalRequest {
 const kind=required(v,'kind',text);
 switch(kind) {
  case 'terminal_exec':
   fields(v,['terminal_id','shell','command','cwd','environment','timeout_seconds','cancel_previous']);
   return Object.freeze({kind,terminal_id:defaulted(v,'terminal_id',optionalText,null),shell:defaulted(v,'shell',shell,'auto'),command:required(v,'command',text),cwd:defaulted(v,'cwd',optionalText,null),environment:defaulted(v,'environment',stringMap,Object.freeze(Object.create(null)) as Readonly<Record<string,string>>),timeout_seconds:defaulted(v,'timeout_seconds',u16,300n),cancel_previous:defaulted(v,'cancel_previous',boolean,false)});
  case 'terminal_window_open':
   fields(v,['shell','cwd']);return Object.freeze({kind,shell:defaulted(v,'shell',windowShell,'powershell'),cwd:defaulted(v,'cwd',optionalText,null)});
  case 'terminal_window_list': fields(v,[]);return Object.freeze({kind});
  case 'terminal_window_close':case 'terminal_window_capture':case 'terminal_window_activate':
   fields(v,['terminal_window_id']);return Object.freeze({kind,terminal_window_id:required(v,'terminal_window_id',text)});
  case 'terminal_window_type':
   fields(v,['terminal_window_id','observation_id','text']);return Object.freeze({kind,terminal_window_id:required(v,'terminal_window_id',text),observation_id:required(v,'observation_id',text),text:required(v,'text',text)});
  case 'terminal_window_keys':
   fields(v,['terminal_window_id','observation_id','keys']);return Object.freeze({kind,terminal_window_id:required(v,'terminal_window_id',text),observation_id:required(v,'observation_id',text),keys:required(v,'keys',strings)});
  case 'terminal_window_interrupt':
   fields(v,['terminal_window_id','observation_id']);return Object.freeze({kind,terminal_window_id:required(v,'terminal_window_id',text),observation_id:required(v,'observation_id',text)});
  default: return jsonError('unknown terminal request kind');
 }
}
/** Full terminal request family: decode every field before semantic validation.
 * No shell/process/window action is performed. Owner must offload large frames. */
export function parseTerminalRequest(raw:string,maxBytes:number):TerminalRequest {
 return validateTerminalRequest(decodeTerminalRequestObject(requestObject(raw,maxBytes)));
}
/** Internal semantic phase for an already decoded family DTO. */
export function validateTerminalRequest(v:TerminalRequest):TerminalRequest {
 if(v.kind==='terminal_exec') {
  if(v.terminal_id!==null)identifier('terminal_id',v.terminal_id,/^term_[a-f0-9]{16}$/u);
  length('command',v.command,1,32_768);if(v.cwd!==null)length('cwd',v.cwd,1,1_000);
  const names=Object.keys(v.environment);count('environment',names.length,0,100);
  for(const name of names.sort(utf8Compare)) {
   const value=v.environment[name]!;length('environment.name',name,1,1_024);
   if(name.includes('=')||name.includes('\0'))validationError('environment.name',"must not contain '=' or NUL");
   length('environment.value',value,0,32_767);if(value.includes('\0'))validationError('environment.value','must not contain NUL');
  }
  if(v.timeout_seconds<1n||v.timeout_seconds>3600n)validationError('timeout_seconds','must be between 1 and 3600');
 } else if(v.kind==='terminal_window_open') {if(v.cwd!==null)length('cwd',v.cwd,1,1_000);}
 else if(v.kind!=='terminal_window_list') {
  identifier('terminal_window_id',v.terminal_window_id,/^termwin_[a-f0-9]{16}$/u);
  if('observation_id' in v)identifier('observation_id',v.observation_id,/^twobs_[a-f0-9]{16}$/u);
  if(v.kind==='terminal_window_type')length('text',v.text,1,4_096);
  if(v.kind==='terminal_window_keys'){count('keys',v.keys.length,1,4);for(const key of v.keys)length('keys',key,1,20);}
 }
 return v;
}
