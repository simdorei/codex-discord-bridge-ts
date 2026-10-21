import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {appendFile,mkdir,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {quoteWindowsArgument} from '../runtime/windows/windows-window-process.ts';
import {runOwnedCommand} from '../runtime/windows/owned-command.ts';
import {runWindowsSupervisor,requestSupervisor,supervisorStatus,type SupervisorAction,type RestartTiming} from '../runtime/windows/supervisor.ts';
import {RuntimeStopSignal} from '../runtime/discord-runtime/stop-signal.ts';
import {runWindowsTray} from './windows-tray.ts';

export function startupTaskName(root:string):string{return 'CodexDiscordTS-'+createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,16);}
function legacyTrayStartupTaskName(root:string):string{return 'CodexDiscordTS-Tray-'+createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,16);}
export function startupTaskAction(root:string,entry:string,node:string,args:readonly string[]):{execute:string;arguments:string;workingDirectory:string;launcher:string}{
 // A scheduler launch (manual or logon) is a new start request. Clear the prior
 // stop only after the supervisor acquires the existing singleton guards.
 const launchPayload=Buffer.from(JSON.stringify({node,args:[entry,'--start-hidden','--runtime-root',root,...args]}),'utf8').toString('base64');
 const launchScript=`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${launchPayload}'))|ConvertFrom-Json; $a=$p.args; & $p.node @a; exit $LASTEXITCODE`;
 const system=join(process.env.SystemRoot??'C:\\Windows','System32'),launcher=fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../../scripts/codex-discord-hidden.vbs':'../../../scripts/codex-discord-hidden.vbs',import.meta.url));
 return {execute:join(system,'wscript.exe'),arguments:['//B','//NoLogo',launcher,join(system,'WindowsPowerShell/v1.0/powershell.exe'),Buffer.from(launchScript,'utf16le').toString('base64')].map(quoteWindowsArgument).join(' '),workingDirectory:root,launcher};
}
export function startupScript(root:string,entry:string,node:string,args:readonly string[],remove=false):string{
 const payload=Buffer.from(JSON.stringify({root,name:startupTaskName(root),trayName:legacyTrayStartupTaskName(root),...startupTaskAction(root,entry,node,args)}),'utf8').toString('base64');
 return `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json; `+
  (remove?`Unregister-ScheduledTask -TaskName $p.name -Confirm:$false -ErrorAction Stop; $legacy=Get-ScheduledTask -TaskName $p.trayName -ErrorAction SilentlyContinue; if($null -ne $legacy){Unregister-ScheduledTask -TaskName $p.trayName -Confirm:$false -ErrorAction Stop;}`:
   `foreach($file in @($p.execute,$p.launcher)){if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'Hidden startup launcher is unavailable'}}; $a=New-ScheduledTaskAction -Execute $p.execute -Argument $p.arguments -WorkingDirectory $p.workingDirectory; $u=[Security.Principal.WindowsIdentity]::GetCurrent().Name; $t=New-ScheduledTaskTrigger -AtLogOn -User $u; $s=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden; $ppl=New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName $p.name -Action $a -Trigger $t -Settings $s -Principal $ppl -Force | Out-Null; $legacy=Get-ScheduledTask -TaskName $p.trayName -ErrorAction SilentlyContinue; if($null -ne $legacy){Unregister-ScheduledTask -TaskName $p.trayName -Confirm:$false -ErrorAction Stop;}`)+` Write-Output $p.name;`;
}
function launchHiddenCommand(entry:string,root:string,args:readonly string[]):Promise<void>{
 const child=spawn(process.execPath,[entry,...args],{cwd:root,env:process.env,stdio:'ignore',shell:false,windowsHide:true,detached:true});
 return new Promise((resolve,reject)=>{const failed=(error:Error)=>{child.off('spawn',started);reject(error);};const started=()=>{child.off('error',failed);child.unref();resolve();};child.once('error',failed);child.once('spawn',started);});
}
async function supervisorIsAlive(root:string):Promise<boolean>{
 try{const manifest=await supervisorStatus(root);process.kill(manifest.processId,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}
}
async function launchHiddenWatchdog(entry:string,root:string,args:readonly string[],clearStop:boolean):Promise<void>{
 if(await supervisorIsAlive(root)){await launchHiddenCommand(entry,root,['--tray','--runtime-root',root]);return;}
 const mode=clearStop?'--start-hidden':'--watchdog-hidden';await launchHiddenCommand(entry,root,[mode,'--runtime-root',root,...args]);
}
async function runResident(root:string,entry:string,args:readonly string[],signal:AbortSignal,clearStop:boolean):Promise<void>{
 const trayStop=new AbortController();const stopTray=()=>trayStop.abort(signal.reason);
 if(signal.aborted)stopTray();else signal.addEventListener('abort',stopTray,{once:true});
 let tray:Promise<void>|undefined;const startTray=()=>{if(tray!==undefined)return;tray=runWindowsTray(root,entry,trayStop.signal).catch(async error=>{
  if(!trayStop.signal.aborted){const detail=error instanceof Error?error.message:'inspect tray logs';await appendFile(join(root,'cdr-stderr.log'),`tray_failed: ${detail}\n`,{encoding:'utf8',mode:0o600}).catch(()=>{});}
 });};
 try{await runWindowsSupervisor({root,entry,arguments:args,environment:Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)),signal,clearStop,onRuntimeStarted:startTray});}
 finally{signal.removeEventListener('abort',stopTray);trayStop.abort();if(tray!==undefined)await tray;}
}
/** Returns null for the legacy runtime command line. No scheduler mutation is
 * performed except for the explicit install/remove flags. */
export async function runWindowsControlCli(argv:readonly string[],entry:string):Promise<number|null>{
 const flag=argv[0];if(!['--tray','--watchdog','--start','--watchdog-hidden','--start-hidden','--install-startup','--remove-startup','--supervisor-control','--supervisor-status'].includes(flag??''))return null;
 if(process.platform!=='win32')throw new Error('This command requires Windows');
 let root=process.cwd(),action:SupervisorAction|undefined,expected:string|undefined;const child:string[]=[],timing:RestartTiming={};
 const timingFlags:Record<string,keyof RestartTiming>={'--delay-seconds':'delaySeconds','--restart-quiet-seconds':'quietSeconds','--restart-wait-timeout-seconds':'waitSeconds'};
 for(let i=1;i<argv.length;i++){const arg=argv[i]!;if(arg==='--runtime-root'){if(!argv[++i])throw new Error('Missing runtime root');root=resolve(argv[i]!);}else if(arg==='--expected-runtime'&&flag==='--supervisor-control'){if(!argv[++i])throw new Error('Missing runtime identity');expected=argv[i];}else if(flag==='--supervisor-control'&&Object.hasOwn(timingFlags,arg)){const key=timingFlags[arg]!,value=argv[++i];if(timing[key]!==undefined||value===undefined||!/^\d+$/u.test(value)||Number(value)>86400)throw new Error('Invalid or repeated restart timing');timing[key]=Number(value);}else if(flag==='--supervisor-control'&&action===undefined&&['restart','force_restart','stop'].includes(arg)){action=arg as SupervisorAction;}else if(arg==='--env'){if(!argv[++i])throw new Error('Missing environment file');child.push('--env',resolve(argv[i]!));}else throw new Error('Unknown supervisor argument');}
 await mkdir(root,{recursive:true});root=await realpath(root);
 if(flag==='--tray'){const stop=RuntimeStopSignal.install();try{await runWindowsTray(root,entry,stop.signal);}finally{stop.dispose();}return 0;}
 if(flag==='--supervisor-status'){process.stdout.write(JSON.stringify(await supervisorStatus(root))+'\n');return 0;}
 if(flag==='--supervisor-control'){if(action===undefined)throw new Error('Expected restart, force_restart or stop');process.stdout.write(JSON.stringify(await requestSupervisor(root,action,undefined,expected,timing))+'\n');return 0;}
 if(flag==='--install-startup'||flag==='--remove-startup'){const script=startupScript(root,entry,process.execPath,child,flag==='--remove-startup'),result=await runOwnedCommand({executable:join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),arguments:['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],environment:{}},{timeoutMs:30000,maxBytes:65536});if(result.exitCode!==0)throw new Error('Scheduled task operation failed');process.stdout.write(result.stdout);return 0;}
 if(flag==='--watchdog'||flag==='--start'){await launchHiddenWatchdog(entry,root,child,flag==='--start');return 0;}
 const environment:Record<string,string>={};for(const[k,v]of Object.entries(process.env))if(v!==undefined)environment[k]=v;
 const stop=RuntimeStopSignal.install();try{await runResident(root,entry,child,stop.signal,flag==='--start-hidden');}finally{stop.dispose();}return 0;
}
