import {createHash} from 'node:crypto';
import {realpath,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {runOwnedCommand} from '../runtime/windows/owned-command.ts';
import {runWindowsSupervisor,requestSupervisor,supervisorStatus,type SupervisorAction,type RestartTiming} from '../runtime/windows/supervisor.ts';
import {RuntimeStopSignal} from '../runtime/discord-runtime/stop-signal.ts';
import {runWindowsTray} from './windows-tray.ts';

export function startupTaskName(root:string):string{return 'CodexDiscordTS-'+createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,16);}
export function startupScript(root:string,entry:string,node:string,args:readonly string[],remove=false):string{
 const launchPayload=Buffer.from(JSON.stringify({node,args:[entry,'--watchdog','--runtime-root',root,...args]}),'utf8').toString('base64');
 const launchScript=`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${launchPayload}'))|ConvertFrom-Json; $a=$p.args; & $p.node @a; exit $LASTEXITCODE`;
 const launchArguments=`-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(launchScript,'utf16le').toString('base64')}`;
 const payload=Buffer.from(JSON.stringify({root,name:startupTaskName(root),launchArguments}),'utf8').toString('base64');
 return `$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json; `+
  (remove?`Unregister-ScheduledTask -TaskName $p.name -Confirm:$false -ErrorAction Stop;`:
   `$runner=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'; $a=New-ScheduledTaskAction -Execute $runner -Argument $p.launchArguments -WorkingDirectory $p.root; $u=[Security.Principal.WindowsIdentity]::GetCurrent().Name; $t=New-ScheduledTaskTrigger -AtLogOn -User $u; $s=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden; $ppl=New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName $p.name -Action $a -Trigger $t -Settings $s -Principal $ppl -Force | Out-Null;`)+` Write-Output $p.name;`;
}
/** Returns null for the legacy runtime command line. No scheduler mutation is
 * performed except for the explicit install/remove flags. */
export async function runWindowsControlCli(argv:readonly string[],entry:string):Promise<number|null>{
 const flag=argv[0];if(!['--tray','--watchdog','--start','--install-startup','--remove-startup','--supervisor-control','--supervisor-status'].includes(flag??''))return null;
 if(process.platform!=='win32')throw new Error('This command requires Windows');
 let root=process.cwd(),action:SupervisorAction|undefined,expected:string|undefined;const child:string[]=[],timing:RestartTiming={};
 const timingFlags:Record<string,keyof RestartTiming>={'--delay-seconds':'delaySeconds','--restart-quiet-seconds':'quietSeconds','--restart-wait-timeout-seconds':'waitSeconds'};
 for(let i=1;i<argv.length;i++){const arg=argv[i]!;if(arg==='--runtime-root'){if(!argv[++i])throw new Error('Missing runtime root');root=resolve(argv[i]!);}else if(arg==='--expected-runtime'&&flag==='--supervisor-control'){if(!argv[++i])throw new Error('Missing runtime identity');expected=argv[i];}else if(flag==='--supervisor-control'&&Object.hasOwn(timingFlags,arg)){const key=timingFlags[arg]!,value=argv[++i];if(timing[key]!==undefined||value===undefined||!/^\d+$/u.test(value)||Number(value)>86400)throw new Error('Invalid or repeated restart timing');timing[key]=Number(value);}else if(flag==='--supervisor-control'&&action===undefined&&['restart','force_restart','stop'].includes(arg)){action=arg as SupervisorAction;}else if(arg==='--env'){if(!argv[++i])throw new Error('Missing environment file');child.push('--env',resolve(argv[i]!));}else throw new Error('Unknown supervisor argument');}
 await mkdir(root,{recursive:true});root=await realpath(root);
 if(flag==='--tray'){const stop=RuntimeStopSignal.install();try{await runWindowsTray(root,entry,stop.signal);}finally{stop.dispose();}return 0;}
 if(flag==='--supervisor-status'){process.stdout.write(JSON.stringify(await supervisorStatus(root))+'\n');return 0;}
 if(flag==='--supervisor-control'){if(action===undefined)throw new Error('Expected restart, force_restart or stop');process.stdout.write(JSON.stringify(await requestSupervisor(root,action,undefined,expected,timing))+'\n');return 0;}
 if(flag==='--install-startup'||flag==='--remove-startup'){const script=startupScript(root,entry,process.execPath,child,flag==='--remove-startup'),result=await runOwnedCommand({executable:join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),arguments:['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],environment:{}},{timeoutMs:30000,maxBytes:65536});if(result.exitCode!==0)throw new Error('Scheduled task operation failed');process.stdout.write(result.stdout);return 0;}
 const environment:Record<string,string>={};for(const[k,v]of Object.entries(process.env))if(v!==undefined)environment[k]=v;
 const stop=RuntimeStopSignal.install();try{await runWindowsSupervisor({root,entry,arguments:child,environment,signal:stop.signal,clearStop:flag==='--start'});}finally{stop.dispose();}return 0;
}
