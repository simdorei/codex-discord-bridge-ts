import type {DatabaseSync} from 'node:sqlite';
import {asyncResolutionHeldIn} from '../store/async-resolution-admission.ts';
/** This inspection never reads request text or changes custody. Optional tables
 * follow the existing legacy schema contract; a present broken table is fatal. */
function optional(db:DatabaseSync,table:string):boolean{
 const row=db.prepare('SELECT type FROM sqlite_schema WHERE name=? COLLATE NOCASE').get(table);
 if(row===undefined)return false;if(row.type!=='table')throw new Error('Invalid legacy work table: '+table);return true;
}
export function legacyMirrorWork(db:DatabaseSync,thread:string):{reason:string|null;dormantHeld:number;observations:Record<string,number|boolean>}{
 let first:string|null=null;const observations:Record<string,number|boolean>={};
 const count=(label:string,sql:string)=>{const n=db.prepare('SELECT COUNT(*) AS n FROM ('+sql+' LIMIT 4097)').get(thread)?.n;
  if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0||n>4096)throw new Error('Legacy work inspection budget exceeded');observations[label]=n;return n;};
 const checks:[string,string,string,boolean][]=[
  ['queue','codex_turn_queue','target_thread_id=?',false],
  ['prompt intake','codex_prompt_intakes','target_thread_id=?',false],
  ['undelivered result','codex_delivery_outbox','target_thread_id=?',false],
  ['undelivered commentary','codex_commentary_outbox','target_thread_id=?',true],
  ['undelivered goal progress','codex_goal_progress','thread=?',false],
  ['live busy choice','busy_choices','target_thread_id=? AND claimed_at IS NULL AND expires_at>unixepoch()',false],
  // fork-handoff-admission.ts creates this journal only when forking is used.
  ['fork handoff','codex_thread_fork_handoffs','(source_thread_id=?1 OR target_thread_id=?1 OR observed_target_thread_id=?1) AND completed_at IS NULL',true],
  ['async question','cdr_async_questions',"thread_id=? AND state NOT IN ('submitted','rejected','closed_unknown','unsupported','expired')",true],
  ['async inbox','cdr_async_question_inbox',"thread_id=? AND state='waiting'",true],
  ['idle release','cdr_idle_release',"thread_id=? AND state NOT IN ('Candidate','Settled')",true],
 ];
 for(const [reason,table,where,mayBeAbsent] of checks){
  if(mayBeAbsent&&!optional(db,table)){observations[table+' present']=false;continue;}
  if(count(table,`SELECT 1 FROM ${table} WHERE ${where}`)>0)first??=reason;
 }
 if(optional(db,'cdr_async_execution_obligations')&&count('async obligations','SELECT 1 FROM cdr_async_unsettled_obligations WHERE thread_id=?')>0)first??='async execution obligation';
 observations.asyncResolutionHeld=asyncResolutionHeldIn(db,thread);if(observations.asyncResolutionHeld)first??='async execution or recovery authorization';
 const invalid=db.prepare("SELECT 1 FROM discord_ingress_journal WHERE target_thread_id=? AND (state IS NULL OR state NOT IN ('staged','acknowledged','executing','owned','completed','held') OR confirmation_delivered NOT IN (0,1)) LIMIT 1").get(thread);
 if(invalid)throw new Error('Unknown legacy ingress state');
 const active=count('active ingress',`SELECT 1 FROM discord_ingress_journal WHERE target_thread_id=? AND NOT (
  (state='held' AND owner_id IS NULL AND owner_kind IS NULL) OR
  (state='completed' AND confirmation_delivered=1) OR
  (state='owned' AND confirmation_delivered=1 AND owner_kind='prompt' AND length(trim(owner_id))>0))`);
 if(active>0)first??='active or recoverable ingress';
 const dormant=count('dormant ingress',"SELECT 1 FROM discord_ingress_journal WHERE target_thread_id=? AND state='held' AND owner_id IS NULL AND owner_kind IS NULL");
 return {reason:first,dormantHeld:first===null?dormant:0,observations};
}
