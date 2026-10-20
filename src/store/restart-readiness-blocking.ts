import {DatabaseSync} from 'node:sqlite';
import {requireDiscordText} from '../discord/text.ts';
import {decodeTextField,textDecoderFor} from './sqlite-values.ts';
import {computeRestartSnapshotPure,compareUtf8Bytes,type RestartReadinessSnapshot,type RestartSnapshotPureInput} from './restart-snapshot-pure.ts';
const MAX_ROWS=10000,MAX_FIELD_BYTES=65536,MAX_INPUT_BYTES=4194304,MAX_OUTPUT_BYTES=4194304;
/** Dedicated worker implementation. Never creates/migrates a DB or starts a transaction.
 * Rows are decoded and evaluated in Rust query order, before later queries begin.
 * Explicit TS result profiles reject excess rows/bytes, never return partial Ready.
 * SQL ORDER BY CPU work is not bounded by the result LIMIT. */
export function restartReadinessSnapshotBlocking(path:string):RestartReadinessSnapshot {
 requireDiscordText(path);
 const db=new DatabaseSync(path,{readOnly:true,timeout:2000,enableForeignKeyConstraints:false});
 let primary:unknown;let failed=false;
 try {
  const decoder=textDecoderFor(db.prepare('PRAGMA encoding').get()?.encoding);
  const targets=new Set<string>(),blockers:string[]=[],observations:string[]=[];
  let scanned=0,inputBytes=0,outputBytes=128;
  const retain=(text:string)=>{outputBytes+=Buffer.byteLength(JSON.stringify(text),'utf8')+1;if(outputBytes>MAX_OUTPUT_BYTES)throw new RangeError('Restart snapshot output byte budget exceeded');};
  const merge=(input:RestartSnapshotPureInput)=>{const s=computeRestartSnapshotPure(input);for(const t of s.targetThreadIds)if(!targets.has(t)){retain(t);targets.add(t);}for(const b of s.blockers){retain(b);blockers.push(b);}for(const o of s.observations){retain(o);observations.push(o);}};
  function* rows(table:string,columns:readonly string[],order:string,optional:readonly number[]=[]):Generator<(string|null)[]> {
   // All identifiers come exclusively from fixed calls below, never external input.
   const projection=columns.flatMap((c,i)=>[
    `length(CAST(${c} AS BLOB)) AS n${i}`,
    `CASE WHEN length(CAST(${c} AS BLOB))<=${MAX_FIELD_BYTES} THEN ${c} END AS c${i}`,
    `CASE WHEN length(CAST(${c} AS BLOB))<=${MAX_FIELD_BYTES} THEN CAST(${c} AS BLOB) END AS b${i}`,
   ]).join(',');
   const stmt=db.prepare(`SELECT ${projection} FROM ${table} ORDER BY ${order} LIMIT ${MAX_ROWS-scanned+1}`);stmt.setReadBigInts(true);
   for(const row of stmt.iterate()){
    if(++scanned>MAX_ROWS)throw new RangeError('Restart snapshot row budget exceeded');
    yield columns.map((c,i)=>{
     const size=row[`n${i}`];
     if(size!==null){if(typeof size!=='bigint'||size<0n||size>BigInt(MAX_FIELD_BYTES))throw new RangeError('Restart snapshot field byte budget exceeded');inputBytes+=Number(size);if(inputBytes>MAX_INPUT_BYTES)throw new RangeError('Restart snapshot input byte budget exceeded');}
     return decodeTextField(row[`c${i}`],row[`b${i}`],c,optional.includes(i),decoder);
    });
   }
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
