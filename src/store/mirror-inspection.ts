import {DatabaseSync} from 'node:sqlite';
import {requireDiscordText} from '../discord/text.ts';
import {normalizeWorkspacePathPosix} from '../codex-state/thread-reference.ts';
import type {MirrorTarget} from './mirror-policy-read.ts';
import {receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeI64} from './sqlite-values.ts';
export interface MirrorInspectionSnapshot {
 readonly mappings:readonly MirrorTarget[];readonly parents:readonly bigint[];
 readonly projectIssues:readonly string[];readonly projectSummary:string;
}
/** Source inspection_snapshot: exactly one read-only transaction over both
 * mapping tables. No schema initialization, migration, current-schema demand or
 * fallback on missing/corrupt data. This synchronous leaf needs an owned worker
 * in the runtime inspector; it is not a network/poll-loop implementation. */
export function mirrorInspectionSnapshotReadonly(path:string):MirrorInspectionSnapshot{
 requireDiscordText(path);if(process.platform==='win32')throw new Error('Windows mirror workspace normalization is not yet qualified');
 const db=new DatabaseSync(path,{readOnly:true});let rows:readonly {row:MirrorTarget;key:string}[],projects:readonly {key:string;channel:bigint}[];
 try{
  db.exec('PRAGMA query_only=true; BEGIN DEFERRED');
  const threads=db.prepare(`SELECT codex_thread_id,thread_title,discord_channel_id,discord_thread_id,project_key,${receiptTextColumns('codex_thread_id','thread_title','project_key')} FROM mirror_threads ORDER BY codex_thread_id`);threads.setReadBigInts(true);
  rows=threads.all().map(row=>({row:Object.freeze({codexThreadId:receiptText(row,'codex_thread_id')!,threadTitle:receiptText(row,'thread_title')!,discordChannelId:decodeI64(row.discord_channel_id,'discord_channel_id'),discordThreadId:decodeI64(row.discord_thread_id,'discord_thread_id')}),key:receiptText(row,'project_key')!}));
  const ps=db.prepare(`SELECT project_key,discord_channel_id,${receiptTextColumns('project_key')} FROM mirror_projects ORDER BY project_key`);ps.setReadBigInts(true);
  projects=ps.all().map(row=>({key:receiptText(row,'project_key')!,channel:decodeI64(row.discord_channel_id,'discord_channel_id')}));db.exec('COMMIT');
 }finally{db.close();}
 const channels=new Map<bigint,number>();for(const p of projects)channels.set(p.channel,(channels.get(p.channel)??0)+1);
 const parents=[...channels.keys()].sort((a,b)=>a<b?-1:a>b?1:0),issues:string[]=[];let duplicate=0,missing=0,mismatch=0,ambiguous=0;
 for(const channel of parents){const count=channels.get(channel)!;if(count>1){duplicate++;issues.push(`duplicate_project_channel | channel=${channel} | projects=${count}`);}}
 for(const {row,key} of rows){
  const candidates=projects.filter(p=>p.key===key||normalizeWorkspacePathPosix(p.key)===normalizeWorkspacePathPosix(key));let issue:string|null=null;
  if(candidates.length===0){missing++;issue='missing_project_mapping';}
  else if(candidates.length>1){ambiguous++;issue='ambiguous_project_mapping';}
  else if(candidates[0]!.channel!==row.discordChannelId){mismatch++;issue='project_parent_mismatch';}
  if(issue!==null)issues.push(`${issue} | thread=${row.codexThreadId} | stored_parent=${row.discordChannelId}`);
 }
 return Object.freeze({mappings:Object.freeze(rows.map(r=>r.row)),parents:Object.freeze(parents),projectIssues:Object.freeze(issues),projectSummary:`missing_project_mapping: ${missing}\nproject_parent_mismatch: ${mismatch}\nambiguous_project_mapping: ${ambiguous}\nduplicate_project_channels: ${duplicate}`});
}
