import {realpath,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {AdminArgs} from './admin-args.ts';
import {runAdminStore} from './admin-store.ts';
import {loadStartupEnvironmentOffThread} from './environment.ts';
import {boundedAdminRead,decodeAdminText,updateAdminEnvironment,verifyInstallInventory} from './admin-files.ts';
import {discoverRuntimePathInputs} from '../runtime/runtime-paths/discovery.ts';
import {resolveRuntimePaths,resolveRuntimeStorePaths,resolveRuntimeStatePaths} from '../runtime/runtime-paths/resolve.ts';
import {rehearseMirrorMigration} from './mirror-rehearsal.ts';
import {legacyMirrorPolicy} from './legacy-mirror-policy.ts';
import {OwnedWorkerSlot} from '../runtime/owned-worker-slot.ts';
import {acquireRuntimePlatform} from '../runtime/runtime-platform.ts';
import {snapshotCutoverStore} from '../store/cutover-backup.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {runThreadAdmin} from './admin-threads.ts';
import {setupDiscord,sendAdminAttachments,discordId} from './admin-http.ts';
import {resolveThreadReferenceOffThread} from '../codex-state/reference-reader.ts';
import {createWindowsRecoveryController} from '../runtime/writer-recovery/windows-controller.ts';
import {recoveryReceiptPath} from '../runtime/writer-recovery/handoff.ts';
import {installBundledPlugin} from './plugin-install.ts';
const slot=new OwnedWorkerSlot('Control');
export async function adminDatabase(data:Record<string,unknown>,signal?:AbortSignal,migration=false):Promise<any>{
 const pending=slot.run(new URL(migration?'./mirror-migration-worker.ts':'./admin-database-worker.ts',import.meta.url),data,migration?30000:10000,signal);let result:any;try{result=await pending;}finally{await slot.join();}
 if(result?.ok!==true)throw new Error(result?.error??'Admin worker outcome unconfirmed; inspect durable evidence');return result.value;
}
/** One-shot CLI authority is explicit and separate from Discord ingress.
 * No gateway starts; reads never initialize stores. Cutover writes require the
 * same runtime exclusion, backed up DB, and original cursor CAS. */
export async function runAdmin(argv:readonly string[],environment:ReadonlyMap<string,string>,cwd:string,version:string,signal?:AbortSignal):Promise<string>{
 const args=AdminArgs.parse(argv),root=resolve(args.root(cwd,process.platform==='win32'?'win32':'posix'));
 if(args.command==='backup-store'||args.command==='active-queue-count')return runAdminStore(argv,environment,cwd,signal);
 if(args.command==='configure-install'){await updateAdminEnvironment(root,{CODEX_HOME:args.required('--codex-home'),...(args.value('--codex-exe')===undefined?{}:{CODEX_EXE:args.required('--codex-exe')})});return 'Configured installation environment; existing unrelated settings preserved.';}
 if(args.command==='setup-discord')return setupDiscord(args,root,signal);
 if(args.command==='verify-plugin-inventory')return 'Verified Codex plugin inventory: '+await verifyInstallInventory(root,resolve(root,args.required('--marketplace-inventory')),resolve(root,args.required('--plugin-inventory')),resolve(root,args.required('--plugin-manifest')),args.value('--marketplace-name')??'codex-discord-remote',args.value('--plugin-id')??'codex-discord-remote@codex-discord-remote');
 const envPath=['migrate-mirror-cursors','rehearse-mirror-migration'].includes(args.command)&&args.value('--env')!==undefined?resolve(root,args.required('--env')):join(root,'.env');
 const env=Object.fromEntries(await loadStartupEnvironmentOffThread(environment,envPath,'',signal));if(args.value('--codex-exe')!==undefined)env.CODEX_EXE=args.required('--codex-exe');if(args.command==='install-plugin'&&args.value('--codex-home')!==undefined)env.CODEX_HOME=args.required('--codex-home');
 const store=resolveRuntimeStorePaths(env,root,env.USERPROFILE??env.HOME??null),database=resolve(cwd,store.mirrorDb);
 if(args.command==='rehearse-mirror-migration'){
  const state=await resolveRuntimeStatePaths(env,env.USERPROFILE??env.HOME??null);
  return serializeSerdeValue(await rehearseMirrorMigration(database,resolve(cwd,state.stateDb),signal,undefined,legacyMirrorPolicy(args.value('--legacy-mirror-policy'))));
 }
 if(args.command==='retire-automatic-reserve'||args.command==='migrate-mirror-cursors'){
  const policy=legacyMirrorPolicy(args.value('--legacy-mirror-policy'));
  const state=policy==='rust-preserve'?await resolveRuntimeStatePaths(env,env.USERPROFILE??env.HOME??null):undefined;
  const guard=await acquireRuntimePlatform(await realpath(resolve(cwd,store.root)));try{
   const backup=await snapshotCutoverStore(database,signal),value=await adminDatabase({path:database,command:args.command,thread:args.value('--thread-id'),policy,...(state===undefined?{}:{statePath:resolve(cwd,state.stateDb)})},signal,args.command==='migrate-mirror-cursors');return serializeSerdeValue({backup,...value});
  }finally{await guard.instance.release();}
 }
 if(args.command==='authorize-saved-final'){const request=decodeAdminText(await boundedAdminRead(resolve(root,args.required('--request-file')))),value=await adminDatabase({path:database,command:args.command,request},signal);return `saved_final_authorized delivery_id=${value.deliveryId} job_id=${value.jobId} (no turn submitted)`;}
 if(['inspect-new-first-reply','inspect-async-recovery','check-recovery-compatibility'].includes(args.command)){
  const path=resolve(root,args.required('--database'));let envPath:string|null=null;
  if(args.command==='check-recovery-compatibility'&&args.value('--env')!==undefined){envPath=await realpath(resolve(cwd,args.required('--env')));if(!(await stat(envPath)).isFile())throw new Error('Explicit environment is not a file');const selected=Object.fromEntries(await loadStartupEnvironmentOffThread(environment,envPath,'',signal)),paths=resolveRuntimeStorePaths(selected,cwd,selected.USERPROFILE??selected.HOME??null),configured=await realpath(resolve(cwd,paths.mirrorDb)),expected=await realpath(path);if(configured.toLowerCase()!==expected.toLowerCase())throw new Error('RECOVERY_COMPATIBILITY_HOLD: configured database differs');}
  const value=await adminDatabase({path,command:args.command,...(args.command==='inspect-new-first-reply'?{job:args.required('--job-id')}:args.command==='inspect-async-recovery'?{thread:args.required('--thread-id')}:{})},signal);
  return serializeSerdeValue(args.command==='check-recovery-compatibility'?{...value,database:await realpath(path),configured_environment_verified:envPath!==null,environment:envPath}:value);
 }
 const paths=()=>discoverRuntimePathInputs(env,root).then(inputs=>resolveRuntimePaths(env,inputs));
 if(args.command==='send-attachment'){
  const targets=['--channel-id','--thread-ref','--work-thread'].filter(k=>args.value(k)!==undefined);if(targets.length!==1)throw new Error('Specify exactly one attachment target');let channel:string;
  if(targets[0]==='--channel-id')channel=discordId(args.required('--channel-id'));
  else{const resolved=await paths(),target=await resolveThreadReferenceOffThread(resolved.stateDb,args.required(targets[0]!),null,false,signal,6000,resolved.bridgeState);channel=String(await adminDatabase({path:resolved.mirrorDb,command:'attachment-target',thread:target.id},signal));}
  return sendAdminAttachments(args,env.DISCORD_BOT_TOKEN??'',channel,signal);
 }
 const resolved=await paths();
 if(args.command==='install-plugin')return installBundledPlugin(root,resolved.codexExe,resolved.codexHome,signal);
 if(args.command==='discover-codex')return resolved.codexExe;
 if(args.command==='list-threads'||args.command==='archive-thread'){const raw=args.value('--limit')??'50';if(!/^\d+$/.test(raw))throw new Error('--limit must be a nonnegative integer');return runThreadAdmin(resolved,version,args.command==='archive-thread'?args.required('--thread-id'):undefined,BigInt(raw),signal);}
 if(args.command==='recover-writer'||args.command==='recover-tools'){
  const thread=args.required('--thread-id'),channel=BigInt(discordId(args.required('--channel-id'))),owner=BigInt(discordId(args.required('--owner-user-id')));if(channel>=1n<<63n||owner>=1n<<63n)throw new Error('Recovery actor exceeds signed64 identity');
  await adminDatabase({path:resolved.mirrorDb,state:resolved.stateDb,command:'active-thread',thread},signal);
  const tools=args.command==='recover-tools',controller=createWindowsRecoveryController(resolved.root,resolved.codexHome,tools?'tools':'writer'),owned=signal??new AbortController().signal;
  try{const inspection=await controller.inspect(thread,owned) as any;if(inspection?.ThreadId!==thread||!(tools?inspection.State==='tools_recovery':['desktop_owned','unlocked'].includes(inspection.State)))throw new Error('Recovery inspection target or ownership is unconfirmed');
   if(args.dryRun)return serializeSerdeValue({phase:tools?'preview_tools':'preview',inspection});
   const cancelled=await adminDatabase({path:resolved.mirrorDb,command:tools?'cancel-tools':'cancel-writer',thread,channel,owner},signal);
   if(!tools&&inspection.State==='unlocked')return serializeSerdeValue({phase:'unlocked',thread,cancelled});
   const identity=tools?inspection.RecoveryIdentity:inspection.WriterIdentity;if(typeof identity!=='string'||!identity)throw new Error('Recovery has no exact process identity');
   const result=await controller.start(thread,identity,owned),receipt=recoveryReceiptPath(resolved.root,result,'win32');return serializeSerdeValue({phase:tools?'dispatched_tools':'dispatched',thread,cancelled:tools?cancelled.jobs:cancelled,started_or_uncertain:tools?cancelled.startedOrUncertain:0,receipt});
  }finally{await controller.join();}
 }
 throw new Error('Unrecognized admin operation');
}
