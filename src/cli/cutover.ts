import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {readFile,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {runOwnedCommand} from '../runtime/windows/owned-command.ts';
import {writeWindowsAtomicFile} from '../runtime/windows/windows-atomic-file.ts';
import {acquireWindowsSingletonOwner,releaseWindowsSingletonOwner} from '../runtime/windows/windows-singleton-owner.ts';
import {quoteWindowsArgument} from '../runtime/windows/windows-window-process.ts';
import {WindowsFilePin} from '../runtime/windows/windows-file-pin.ts';
import {startupTaskName} from './windows-control.ts';
export interface CutoverState{version:1;operation:string;phase:string;root:string;entry:string;node:string;binary:string;env:string;taskName:string;taskArguments:string;disableText:string;stopText:string;inventory:unknown;backup:string|null;target:unknown;}
export type CutoverAction='inventory'|'preflight'|'backup'|'prepare'|'stop-legacy'|'migrate-store'|'install-target'|'start-target'|'observe-target'|'stop-target'|'restore-legacy';
export interface CutoverPorts{perform:(action:CutoverAction,state:CutoverState)=>Promise<any>;save:(state:CutoverState)=>Promise<void>;}
/** Persist intent before every external effect. Recovery proves the target has
 * stopped before re-enabling the source; it never restores a stale DB snapshot. */
export async function executeCutover(state:CutoverState,ports:CutoverPorts,recover=false):Promise<CutoverState>{
 const phase=async(name:string)=>{state.phase=name;await ports.save({...state});};
 if(recover){await phase('recovery_stopping_target');await ports.perform('stop-target',state);await phase('recovery_restoring_source');await ports.perform('restore-legacy',state);await phase('rolled_back');return state;}
 if(state.phase!=='inventoried')throw Error('An existing cutover requires --recover-cutover');
 await ports.perform('preflight',state);await phase('backing_up');state.backup=await ports.perform('backup',state);await phase('backup_verified');
 try{
  await phase('disabling_source');await ports.perform('prepare',state);await phase('stopping_source');await ports.perform('stop-legacy',state);
  await phase('migrating_store');await ports.perform('migrate-store',state);
  await phase('installing_target');await ports.perform('install-target',state);await phase('starting_target');await ports.perform('start-target',state);
  await phase('observing_target');state.target=await ports.perform('observe-target',state);await phase('complete');return state;
 }catch(primary){
  try{await phase('recovery_stopping_target');await ports.perform('stop-target',state);await phase('recovery_restoring_source');await ports.perform('restore-legacy',state);await phase('rolled_back');}
  catch(recovery){await phase('recovery_required');throw new AggregateError([primary,recovery],'Cutover requires explicit recovery; source remains fenced and DB is preserved');}
  throw new Error('Cutover failed; the source configuration was restored and DB retained',{cause:primary});
 }
}
export async function runCutoverCli(argv:readonly string[],entry:string):Promise<number|null>{
 if(!['--cutover-from-rust','--recover-cutover'].includes(argv[0]??''))return null;if(process.platform!=='win32')throw Error('Runtime cutover currently requires Windows');
 const args=new Map<string,string>();let dry=false;for(let i=1;i<argv.length;i++){const key=argv[i]!;if(key==='--dry-run'&&!dry){dry=true;continue;}if(!['--runtime-root','--legacy-binary','--env'].includes(key)||args.has(key)||!argv[i+1])throw Error('Invalid cutover option');args.set(key,argv[++i]!);}
 const root=await realpath(resolve(args.get('--runtime-root')??process.cwd())),statePath=join(root,'.cdr-ts-cutover.json'),recover=argv[0]==='--recover-cutover';
 const script=fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../../scripts/CdrRuntimeCutover.ps1':'../../../scripts/CdrRuntimeCutover.ps1',import.meta.url));
 const perform=async(action:CutoverAction,state:CutoverState)=>{const payload=Buffer.from(JSON.stringify({action,state})).toString('base64');const result=await runOwnedCommand({executable:join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),arguments:['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',script,'-Payload',payload],cwd:root,environment:{CODEX_DISCORD_ROOT:root}},{timeoutMs:300000,maxBytes:1048576});if(result.exitCode!==0)throw Error('Cutover '+action+' failed; '+result.stderr.toString().slice(0,1200));return JSON.parse(result.stdout.toString().replace(/^\uFEFF/u,'').trim());};
 let existing:CutoverState|null=null;try{existing=JSON.parse(await readFile(statePath,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(recover&&!existing)throw Error('No interrupted cutover record exists');if(existing&&(existing.version!==1||existing.root!==root||existing.entry!==entry||existing.node!==process.execPath))throw Error('Cutover record belongs to another installation');
 if(existing&&!recover)throw Error('Cutover record already exists; inspect it or use --recover-cutover');
 const operation=randomUUID(),state:CutoverState=existing??{version:1,operation,phase:'inventoried',root,entry,node:process.execPath,binary:await realpath(resolve(args.get('--legacy-binary')??join(root,'target/release/cdr-runtime.exe'))),env:await realpath(resolve(args.get('--env')??join(root,'.env'))),taskName:startupTaskName(root),taskArguments:[entry,'--watchdog','--runtime-root',root,'--env',resolve(args.get('--env')??join(root,'.env'))].map(quoteWindowsArgument).join(' '),disableText:'kind=ts_cutover\ntransaction_id='+operation+'\n',stopText:'ts_cutover_stop='+operation+'\n',inventory:null,backup:null,target:null};
 if(!existing)state.inventory=await perform('inventory',state);
 if(dry){process.stdout.write(JSON.stringify({dryRun:true,recover,state})+'\n');return 0;}
 const pin=WindowsFilePin.acquire(root,'directory');let guard;
 try{guard=acquireWindowsSingletonOwner(join(root,'.cdr-ts-cutover'));}catch(error){pin.close();throw error;}
 try{let current:CutoverState|null=null;try{current=JSON.parse(await readFile(statePath,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(current?.operation!==existing?.operation)throw Error('Cutover journal changed after inventory');const result=await executeCutover(state,{perform,save:value=>writeWindowsAtomicFile(statePath,JSON.stringify(value,null,2)+'\n')},recover);process.stdout.write(JSON.stringify({phase:result.phase,backup:result.backup,state:statePath})+'\n');return 0;}finally{pin.close();const released=await releaseWindowsSingletonOwner(guard);if(released.closure!=='closed')throw Error('Cutover ownership release is unconfirmed');}
}
