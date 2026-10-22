import {quoteWindowsArgument} from '../runtime/windows/windows-window-process.ts';
import type {PortableProcessConfig} from '../app-server/portable-process.ts';
import type {CutoverAction,CutoverState} from './cutover.ts';

const actions:readonly CutoverAction[]=['inventory','preflight','rehearse-store','backup','prepare','stop-legacy','migrate-store','install-target','start-target','observe-target','stop-target','restore-legacy'];
/** Only control inputs consumed by CdrRuntimeCutover.ps1 cross this boundary.
 * Migration reports and other growing evidence belong in the durable journal,
 * never in argv: a large report must not disable both startup and rollback. */
export function cutoverControlState(state:CutoverState){
 const {root,entry,node,binary,env,taskName,taskExecute,taskArguments,disableText,stopText,inventory,legacyMirrorPolicy}=state;
 return {root,entry,node,binary,env,taskName,taskExecute,taskArguments,disableText,stopText,inventory,legacyMirrorPolicy};
}
export function requireWindowsCommandCapacity(executable:string,args:readonly string[]):number{
 const units=[executable,...args].map(quoteWindowsArgument).join(' ').length+1;
 if(units>32767)throw new Error(`Cutover Windows command exceeds the 32767 UTF-16 unit limit (${units}); control data was not truncated`);
 return units;
}
export function nativeCutoverCommand(action:CutoverAction,state:CutoverState,script:string,executable:string):PortableProcessConfig{
 const payload=Buffer.from(JSON.stringify({action,state:cutoverControlState(state)}),'utf8').toString('base64');
 const args=['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',script,'-Payload',payload];
 requireWindowsCommandCapacity(executable,args);
 return {executable,arguments:args,cwd:state.root,environment:{CODEX_DISCORD_ROOT:state.root}};
}
/** Inventory is the last change to wire control inputs. Check every later
 * action before a fresh journal or service effect, including rollback actions. */
export function validateCutoverCommandCapacity(state:CutoverState,script:string,executable:string):void{
 for(const action of actions)nativeCutoverCommand(action,state,script,executable);
}
