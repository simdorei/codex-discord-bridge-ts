import {mkdtemp,rm,stat,realpath} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {OwnedWorkerSlot} from '../runtime/owned-worker-slot.ts';
import {WindowsWindowProcess} from '../runtime/windows/windows-window-process.ts';
import {RemoteComputerObservationOwner,type RemoteComputerIdentity} from './computer-observation.ts';
import type {ComputerRequest} from './computer-request.ts';
import type {RemoteComputerOutput} from './computer-output.ts';
import type {OwnedRemoteComputerPorts,RemoteComputerMode} from './session-computer.ts';
import {terminalEnvironment} from './native-terminal.ts';
import {normalizeDeviceKeys} from '../runtime/windows/window-native.ts';
type WindowEntry=Extract<RemoteComputerOutput,{kind:'computer_windows'}>['windows'][number];
export interface NativeWindowResult{readonly identity:RemoteComputerIdentity;readonly entry:WindowEntry;readonly data_base64?:string;}
const slot=new OwnedWorkerSlot();
export async function windowNativeOperation(input:unknown):Promise<unknown>{
 const pending=slot.run(new URL('../runtime/windows/window-worker.ts',import.meta.url),input,15000),joined=slot.join();let result;
 try{result=await pending;}finally{await joined;}
 const output=result as {ok:boolean;result:unknown;error?:string};if(output.ok!==true)throw new Error(output.error??'Windows native operation failed');return output.result;
}
const protectedText=['1password','additional verification','authentication','authenticator','bitwarden','chatgpt','chrome remote desktop','codex','credential manager','developer tools','devtools','enter your password','enter code','google accounts','lastpass','one-time code','one-time password','passcode','password','privacy & security','sign in','sign-in','two-step verification','2-step verification','verification','verification code',"verify it's you",'confirm your identity','account recovery','recovery code','security check','security code','access code','windows security','로그인','본인인증','비밀번호','암호 입력','인증번호','보안 코드','본인 확인','계정 복구','추가인증','개인 정보 및 보안'];
const protectedTitles=['open','page setup','print','run','save as','열기','실행','인쇄','다른 이름으로 저장'];
export function projectWindowPolicy(window:NativeWindowResult,interactive=false):WindowEntry{
 const name=window.entry.process_name.toLowerCase(),title=window.entry.title.toLowerCase().trim().replace(/\s+/g,' '),path=window.identity.process_path.toLowerCase();
 const chrome=['PROGRAMFILES','PROGRAMFILES(X86)','LOCALAPPDATA'].flatMap(key=>process.env[key]?[join(process.env[key]!,'Google','Chrome','Application','chrome.exe').toLowerCase()]:[]);
 const notepad=join(process.env.SystemRoot??'C:\\Windows','System32','notepad.exe').toLowerCase(),apps=join(process.env.ProgramFiles??'C:\\Program Files','WindowsApps').toLowerCase()+'\\microsoft.windowsnotepad_';
 if(name==='chrome.exe'?!chrome.includes(path):name!=='notepad.exe'||path!==notepad&&!(path.startsWith(apps)&&path.endsWith('\\notepad.exe')))throw new Error('Application is not approved for project control');
 if(protectedTitles.includes(title)||protectedText.some(marker=>title.includes(marker)))throw new Error('Protected window requires direct user control');
 if(interactive&&name!=='notepad.exe')throw new Error('Chrome interactions require direct user control');return {...window.entry,title:name==='chrome.exe'?'Google Chrome':'Notepad'};
}
export function requireProjectKeys(keys:readonly string[]):void{const normalized=normalizeDeviceKeys(keys),single=['BACKSPACE','DELETE','DOWN','END','ENTER','ESC','HOME','LEFT','PAGEDOWN','PAGEUP','RIGHT','SPACE','TAB','UP'];if(!(normalized.length===1&&single.includes(normalized[0]!)||normalized.length===2&&normalized.includes('CTRL')&&['A','C','X','Z'].some(k=>normalized.includes(k))))throw new Error('Protected keyboard shortcut is unavailable');}
type Application={app:'chrome'|'notepad';process:WindowsWindowProcess;window:NativeWindowResult;profile:string|null;};
export async function createWindowsComputer(mode:RemoteComputerMode):Promise<OwnedRemoteComputerPorts>{
 if(process.platform!=='win32')throw new Error('Computer control is available only on Windows');
 const owned=new Map<bigint,Application>(),observations=new RemoteComputerObservationOwner(30000);let stopped=false,closing:Promise<void>|undefined;
 const verifyOwned=(window:NativeWindowResult)=>{if(mode==='project'){const app=owned.get(window.entry.window_id);if(!app||!app.process.running()||app.window.identity.process_id!==window.identity.process_id||app.window.identity.process_path!==window.identity.process_path)throw new Error('Only this session\'s launched windows can be controlled');projectWindowPolicy(window);}};
 const inspect=async(id:bigint)=>{const value=await windowNativeOperation({kind:'inspect',id}) as NativeWindowResult;verifyOwned(value);return value;};
 const removeProfile=async(profile:string)=>{const parent=await realpath(tmpdir()),actual=resolve(profile);if(dirname(actual)!==parent||!actual.startsWith(join(parent,'cdr-mcp-chrome-')))throw new Error('Unknown Chrome profile cleanup path');await rm(actual,{recursive:true,force:true});};
 const cleanup=async(app:Application)=>{await app.process.close();if(app.profile!==null)await removeProfile(app.profile);};
 const launch=async(app:'chrome'|'notepad')=>{
  for(const [id,previous]of owned)if(!previous.process.running()){await cleanup(previous);owned.delete(id);}
  if([...owned.values()].some(a=>a.app===app))throw new Error('This session already launched this application');const candidates=app==='notepad'?[join(process.env.SystemRoot??'C:\\Windows','System32','notepad.exe')]:['PROGRAMFILES','PROGRAMFILES(X86)','LOCALAPPDATA'].flatMap(key=>process.env[key]?[join(process.env[key]!,'Google','Chrome','Application','chrome.exe')]:[]);let executable:string|undefined;for(const p of candidates)if(await stat(p).then(s=>s.isFile(),()=>false)){executable=p;break;}if(!executable)throw new Error('Application is not installed in a standard location');
  const profile=app==='chrome'?await mkdtemp(join(await realpath(tmpdir()),'cdr-mcp-chrome-')):null;let launched:WindowsWindowProcess|undefined;
  try{const args=profile===null?[]:['--user-data-dir='+profile,'--guest','--no-first-run','--disable-sync','--disable-background-mode','--new-window','about:blank'];launched=await WindowsWindowProcess.launch(executable,args,dirname(executable),terminalEnvironment());let prior:NativeWindowResult|undefined;const deadline=performance.now()+8000;
   while(performance.now()<deadline){const windows=await windowNativeOperation({kind:'list'}) as NativeWindowResult[];const current=windows.find(w=>w.identity.process_id===BigInt(launched!.processId));if(current){projectWindowPolicy(current);if(prior&&prior.identity.window_id===current.identity.window_id&&prior.identity.title_digest===current.identity.title_digest){owned.set(current.entry.window_id,{app,process:launched,window:current,profile});return;}prior=current;}await sleep(50);}
   throw new Error('Launched application did not expose a stable window');
  }catch(error){if(launched)await launched.close();if(profile!==null)await removeProfile(profile);throw error;}
 };
 const execute=async(request:Exclude<ComputerRequest,{kind:'computer_stop'}>):Promise<RemoteComputerOutput>=>{
  if(stopped)throw new Error('Computer controller is stopped');
  if(request.kind==='computer_launch'){await launch(request.app);return {kind:'computer_action',action:'launch',window_id:null,message:request.app+' launch requested.'};}
  if(request.kind==='computer_list_windows'){const all=await windowNativeOperation({kind:'list'}) as NativeWindowResult[];if(mode==='device')return {kind:'computer_windows',windows:all.map(w=>w.entry)};const windows:WindowEntry[]=[];for(const value of all)if(owned.has(value.entry.window_id)){verifyOwned(value);windows.push(projectWindowPolicy(value));}return {kind:'computer_windows',windows};}
  if(!('window_id' in request))throw new TypeError('Expected window request');const current=await inspect(request.window_id);
  if(request.kind==='computer_screenshot'){if(mode==='project')projectWindowPolicy(current,true);const captured=await windowNativeOperation({kind:'capture',id:request.window_id,identity:current.identity}) as NativeWindowResult;verifyOwned(captured);if(current.identity.title_digest!==captured.identity.title_digest||current.identity.process_id!==captured.identity.process_id)throw new Error('Window changed before capture');return {kind:'computer_screenshot',observation_id:observations.record(captured.identity),window:mode==='project'?projectWindowPolicy(captured,true):captured.entry,media_type:'image/png',data_base64:captured.data_base64!};}
  if(request.kind==='computer_activate'){await windowNativeOperation({kind:'action',request,identity:current.identity});return {kind:'computer_action',action:'activate',window_id:request.window_id,message:'Window activated.'};}
  if(mode==='project'){projectWindowPolicy(current,request.kind!=='computer_close');if(request.kind==='computer_press_keys')requireProjectKeys(request.keys);if(request.kind==='computer_click'&&request.button!=='left')throw new Error('Project mode supports left clicks only');}
  const points:readonly(readonly[bigint,bigint])[]=request.kind==='computer_click'||request.kind==='computer_scroll'?[[request.x,request.y]]:request.kind==='computer_drag'?[[request.start_x,request.start_y],[request.end_x,request.end_y]]:[];
  if(!('observation_id' in request))throw new TypeError('Expected observed request');const identity=observations.consume(request.observation_id,request.window_id,points);await windowNativeOperation({kind:'action',request,identity});return {kind:'computer_action',action:request.kind.slice('computer_'.length) as Extract<RemoteComputerOutput,{kind:'computer_action'}>['action'],window_id:request.window_id,message:'Window action completed.'};
 };
 return Object.freeze({execute,stop:()=>{stopped=true;observations.clear();return closing??=(async()=>{for(const [id,app]of owned){await cleanup(app);owned.delete(id);}})();}});
}
