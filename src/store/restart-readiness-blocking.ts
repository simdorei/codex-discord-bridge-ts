import {DatabaseSync} from 'node:sqlite';
import {requireDiscordText} from '../discord/text.ts';
import {decodeTextField,textDecoderFor} from './sqlite-values.ts';
import {computeRestartSnapshotPure,compareUtf8Bytes,type RestartReadinessSnapshot,type RestartSnapshotPureInput} from './restart-snapshot-pure.ts';
/** Dedicated worker implementation. Never creates/migrates a DB or starts a transaction.
 * Rows are decoded and evaluated in Rust query order, before later queries begin. */
export function restartReadinessSnapshotBlocking(path:string):RestartReadinessSnapshot {
 requireDiscordText(path);
 const db=new DatabaseSync(path,{readOnly:true,timeout:2000,enableForeignKeyConstraints:false});
 let primary:unknown;let failed=false;
 try {
  const decoder=textDecoderFor(db.prepare('PRAGMA encoding').get()?.encoding);
  const targets=new Set<string>(),blockers:string[]=[],observations:string[]=[];
  const merge=(input:RestartSnapshotPureInput)=>{const s=computeRestartSnapshotPure(input);for(const t of s.targetThreadIds)targets.add(t);blockers.push(...s.blockers);observations.push(...s.observations);};
  function* rows(table:string,columns:readonly string[],order:string,optional:readonly number[]=[]):Generator<(string|null)[]> {
   // All identifiers come exclusively from fixed calls below, never external input.
   const projection=columns.flatMap((c,i)=>[`${c} AS c${i}`,`CAST(${c} AS BLOB) AS b${i}`]).join(',');
   const stmt=db.prepare(`SELECT ${projection} FROM ${table} ORDER BY ${order}`);stmt.setReadBigInts(true);
   for(const row of stmt.iterate())yield columns.map((c,i)=>decodeTextField(row[`c${i}`],row[`b${i}`],c,optional.includes(i),decoder));
  }
  const exists=(name:string)=>{const s=db.prepare("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?) AS present");s.setReadBigInts(true);return s.get(name)?.present===1n;};
  for(const r of rows('mirror_threads',['codex_thread_id'],'codex_thread_id'))merge({mirrorThreads:[r[0]!] as string[]});
  for(const r of rows('codex_turn_queue',['job_id','target_thread_id','state','turn_id','last_error'],'job_id',[3]))merge({turnQueue:[[r[0]!,r[1]!,r[2]!,r[3]!,r[4]!] as [string,string,string,string|null,string]]});
  if(exists('codex_prompt_intakes'))for(const r of rows('codex_prompt_intakes',['job_id','target_thread_id','claim_token'],'job_id',[2]))merge({promptIntakes:[[r[0]!,r[1]!,r[2]!] as [string,string,string|null]]});
  if(exists('codex_app_server_managed_targets'))for(const r of rows('codex_app_server_managed_targets',['thread_id'],'thread_id'))merge({appServerManagedTargets:[r[0]!] as string[]});
  if(exists('codex_thread_fork_handoffs'))for(const r of rows('codex_thread_fork_handoffs',['handoff_id','source_thread_id','observed_target_thread_id','target_thread_id'],'handoff_id',[2,3]))merge({threadForkHandoffs:[[r[0]!,r[1]!,r[2]!,r[3]!] as [string,string,string|null,string|null]]});
  return {targetThreadIds:[...targets].sort(compareUtf8Bytes),blockers:blockers.sort(compareUtf8Bytes),observations:observations.sort(compareUtf8Bytes)};
 }catch(error){failed=true;primary=error;throw error;}finally{try{db.close();}catch(error){if(failed)throw new AggregateError([primary,error],'Restart snapshot read and close failed');throw error;}}
}
