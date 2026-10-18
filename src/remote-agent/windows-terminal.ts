import {randomBytes,createHash} from 'node:crypto';
import {realpath,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {WindowsWindowProcess} from '../runtime/windows/windows-window-process.ts';
import {windowNativeOperation,type NativeWindowResult} from './windows-computer.ts';
import {terminalEnvironment,findNativeExecutable} from './native-terminal.ts';
import {normalizeDeviceKeys} from '../runtime/windows/window-native.ts';
import {redactRemoteText} from './files/redaction.ts';
import type {TerminalRequest} from './terminal-request.ts';
import type {RemoteTerminalOutput} from './terminal-output.ts';
import type {RemoteOperationContext} from './dispatcher-ports.ts';
import type {RemoteComputerIdentity} from './computer-observation.ts';
const generated=(prefix:string)=>prefix+randomBytes(8).toString('hex');
type Entry=Extract<RemoteTerminalOutput,{kind:'terminal_window_open'}>['window'];
type Owned={process:WindowsWindowProcess;window:NativeWindowResult;entry:Entry;observation:{id:string;identity:RemoteComputerIdentity;expires:number;digest:string}|null;};
const utc=()=>{const ms=BigInt(Date.now());return {seconds:ms/1000n,nanosecond:ms%1000n*1000000n};};
export class WindowsTerminalWindows{
 readonly #owned=new Map<string,Owned>();#closed=false;#busy=false;#active:Promise<RemoteTerminalOutput>|null=null;#closing:Promise<void>|undefined;
 constructor(readonly root:string){}
 execute(request:TerminalRequest,context:RemoteOperationContext):Promise<RemoteTerminalOutput>{if(this.#closed||this.#busy)return Promise.reject(new Error('Terminal window session is closed or busy'));this.#busy=true;const task=this.#execute(request,context).finally(()=>{this.#busy=false;this.#active=null;});this.#active=task;return task;}
 async #inspect(owned:Owned){if(!owned.process.running())throw new Error('Terminal window process exited');const current=await windowNativeOperation({kind:'inspect',id:owned.entry.window_id}) as NativeWindowResult;if(current.identity.process_id!==owned.window.identity.process_id||current.identity.process_path!==owned.window.identity.process_path)throw new Error('Terminal window identity changed');return current;}
 async #execute(request:TerminalRequest,context:RemoteOperationContext):Promise<RemoteTerminalOutput>{
  if(process.platform!=='win32')throw new Error('Terminal windows require Windows');context.signal.throwIfAborted();context.budget.remaining();
  if(request.kind==='terminal_exec')throw new TypeError('Expected terminal window request');
  if(request.kind==='terminal_window_open'){
   if(this.#owned.size>=8)throw new Error('Terminal window capacity reached');const cwd=await realpath(request.cwd===null?this.root:resolve(this.root,request.cwd));if(!(await stat(cwd)).isDirectory())throw new Error('Terminal cwd is unavailable');const id=generated('termwin_'),title='CDR '+id,executable=await findNativeExecutable(request.shell==='powershell'?['pwsh','powershell']:[process.env.ComSpec??'cmd']);
   const args=request.shell==='powershell'?['-NoLogo','-NoProfile','-NoExit','-Command','$Host.UI.RawUI.WindowTitle=$env:SIMDOREI_MCP_TERMINAL_WINDOW_TITLE']:['/D','/K','title '+title];
   const child=await WindowsWindowProcess.launch(executable,args,cwd,{...terminalEnvironment(),SIMDOREI_MCP_TERMINAL_WINDOW_TITLE:title},true);
   try{const deadline=performance.now()+10000;while(performance.now()<deadline){context.signal.throwIfAborted();context.budget.remaining();const windows=await windowNativeOperation({kind:'list'}) as NativeWindowResult[],window=windows.find(w=>w.entry.title.endsWith(title));if(window){const entry:Entry={terminal_window_id:id,window_id:window.entry.window_id,process_id:BigInt(child.processId),shell:request.shell,cwd,title:await redactRemoteText(window.entry.title),running:true};this.#owned.set(id,{process:child,window,entry,observation:null});return {kind:'terminal_window_open',window:entry};}await sleep(50);}throw new Error('Terminal did not open a matching window');}catch(error){await child.close();throw error;}
  }
  if(request.kind==='terminal_window_list'){const windows:Entry[]=[];for(const owned of this.#owned.values())if(owned.process.running()){const current=await this.#inspect(owned);windows.push({...owned.entry,title:await redactRemoteText(current.entry.title)});}return {kind:'terminal_window_list',windows};}
  const owned=this.#owned.get(request.terminal_window_id);if(!owned)throw new Error('Terminal window belongs to another session');
  if(request.kind==='terminal_window_close'){await owned.process.close();this.#owned.delete(request.terminal_window_id);return {kind:'terminal_window_close',terminal_window_id:request.terminal_window_id,closed:true};}
  const current=await this.#inspect(owned),entry={...owned.entry,title:await redactRemoteText(current.entry.title)};
  if(request.kind==='terminal_window_capture'){
   const capture=await windowNativeOperation({kind:'capture',id:entry.window_id,identity:current.identity,allowInactive:true}) as NativeWindowResult;const observation_id=generated('twobs_'),digest=createHash('sha256').update(Object.values(capture.identity).map(String).join('\0')).digest('hex');
   owned.observation={id:observation_id,identity:capture.identity,expires:performance.now()+30000,digest};return {kind:'terminal_window_capture',window:entry,observation_id,identity_digest:digest,rect:{left:capture.entry.left,top:capture.entry.top,width:capture.entry.width,height:capture.entry.height},media_type:'image/png',data_base64:capture.data_base64!,captured_at:utc()};
  }
  let observation_id:string|null=null,identity=current.identity,digest=createHash('sha256').update(Object.values(identity).map(String).join('\0')).digest('hex');let action:'activate'|'type'|'keys'|'interrupt',unicode_chars=0n,keys:readonly string[]=[];
  if(request.kind==='terminal_window_activate')action='activate';else{
   if(!('observation_id' in request))throw new TypeError('Observed terminal request required');const observation=owned.observation;owned.observation=null;if(!observation||observation.id!==request.observation_id||performance.now()>=observation.expires)throw new Error('Fresh terminal screenshot required');for(const k of ['window_id','process_id','process_path','left','top','width','height']as const)if(observation.identity[k]!==current.identity[k])throw new Error('Terminal changed after screenshot');identity=current.identity;observation_id=observation.id;digest=observation.digest;
   action=request.kind==='terminal_window_type'?'type':request.kind==='terminal_window_interrupt'?'interrupt':'keys';if(request.kind==='terminal_window_type')unicode_chars=BigInt([...request.text].length);else keys=normalizeDeviceKeys(request.kind==='terminal_window_interrupt'?['CTRL','C']:request.keys);
  }
  await windowNativeOperation({kind:'action',request:{kind:'computer_activate',window_id:entry.window_id},identity});
  if(action!=='activate')await windowNativeOperation({kind:'action',request:action==='type'?{kind:'computer_type_text',window_id:entry.window_id,observation_id,text:(request as Extract<TerminalRequest,{kind:'terminal_window_type'}>).text}:{kind:'computer_press_keys',window_id:entry.window_id,observation_id,keys},identity});
  return {kind:'terminal_window_action',window:entry,receipt:{receipt_id:generated('twrcpt_'),terminal_window_id:entry.terminal_window_id,observation_id,identity_digest:digest,action,unicode_chars,keys,activated:true,completed_at:utc()}};
 }
 close():Promise<void>{this.#closed=true;return this.#closing??=(async()=>{try{await this.#active;}catch{}for(const [id,owned]of this.#owned){await owned.process.close();this.#owned.delete(id);}})();}
}
