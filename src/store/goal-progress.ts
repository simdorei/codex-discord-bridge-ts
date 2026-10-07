import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {selectJob,snapshotStoredQueueJob,storedQueueJobsEqual,InvalidQueueStateError,type StoredQueueJob} from "./queue-read.ts";
import {targetIsHeldIn} from "./dead-generation-admission.ts";
import {DeadGenerationTargetHeldError} from "./fork-completed-target.ts";
import {recordJobOrigin} from "./mirror-origin.ts";
import {retainAsyncTerminalJournalIn} from "./async-resolution-terminal.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {takeUnicodeScalarChars} from "./queue-preflight-failure.ts";
export interface PendingGoalProgress{jobId:string|null;thread:string;turn:string;channel:bigint;content:string;lastError:string}
const STRINGS=["thread","turn","content","last_error","job_id"];
const SELECT=`SELECT thread,turn,channel,content,last_error,job_id,${STRINGS.map(c=>`CAST(${c} AS BLOB) AS b_${c}`).join(",")},
  (SELECT encoding FROM pragma_encoding) AS encoding FROM codex_goal_progress`;
function read(row:Record<string,unknown>):PendingGoalProgress{
  const decoder=textDecoderFor(row.encoding),text=(key:string,optional=false)=>decodeTextField(row[key],row["b_"+key],key,optional,decoder);
  const thread=text("thread")!,turn=text("turn")!,channel=decodeI64(row.channel,"channel"),content=text("content")!,lastError=text("last_error")!,jobId=text("job_id",true);
  return {jobId,thread,turn,channel,content,lastError};
}
function validText(value:unknown):asserts value is string{
  if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed text");
}
export async function stageOwnedGoalProgress(path:string,input:StoredQueueJob,content:string):Promise<PendingGoalProgress|null>{
  validText(path);validText(content);const expected=snapshotStoredQueueJob(input);
  if(expected.turnId===null)throw new InvalidQueueStateError("goal progress owner has no turn");
  const db=await openInitialized(path);let committed=false;
  try{
    db.exec("BEGIN IMMEDIATE");const job=selectJob(db,expected.jobId);
    const count=db.prepare("SELECT count(*) AS n FROM codex_turn_queue WHERE target_thread_id=? AND state='running'");count.setReadBigInts(true);
    const owners=decodeI64(count.get(expected.targetThreadId)?.n,"running owners");
    if(!storedQueueJobsEqual(expected,job)||owners!==1n)throw new InvalidQueueStateError("goal progress ownership changed");
    if(targetIsHeldIn(db,job.targetThreadId))throw new DeadGenerationTargetHeldError(job.targetThreadId);
    if(job.state!=="Running"||job.turnId!==expected.turnId||job.appServerGeneration!==expected.appServerGeneration)throw new InvalidQueueStateError("goal progress ownership changed");
    let pending:PendingGoalProgress|null=null;
    if(content!==""){
      db.prepare("INSERT OR IGNORE INTO codex_goal_progress(thread,turn,channel,content,job_id) VALUES(?,?,?,?,?)").run(job.targetThreadId,job.turnId,job.channelId,content,job.jobId);
      const query=db.prepare(SELECT+" WHERE thread=? AND turn=?");query.setReadBigInts(true);
      const row=query.get(job.targetThreadId,job.turnId);if(!row)throw new InvalidQueueStateError("goal progress payload missing");pending=read(row);
      if(pending.channel!==job.channelId||pending.content!==content||pending.jobId!==job.jobId)throw new InvalidQueueStateError("goal progress payload conflict");
    }
    recordJobOrigin(db,job);
    db.prepare("INSERT OR IGNORE INTO codex_session_mirror_events(event_digest,codex_thread_id,created_at) VALUES(?,?,?)")
      .run(`discord-origin:v1:${job.targetThreadId}:${job.turnId}`,job.targetThreadId,job.updatedAt);
    db.prepare("UPDATE codex_turn_queue SET goal_waiting=1 WHERE job_id=?").run(job.jobId);
    if(!retainAsyncTerminalJournalIn(db,job.targetThreadId,job.turnId))db.prepare("DELETE FROM codex_observed_completions WHERE thread_id=? AND turn_id=?").run(job.targetThreadId,job.turnId);
    db.prepare("DELETE FROM codex_observed_final_answers WHERE thread_id=? AND turn_id=?").run(job.targetThreadId,job.turnId);
    db.exec("COMMIT");committed=true;return pending;
  }finally{if(!committed&&db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}
export async function pendingGoalProgress(path:string):Promise<PendingGoalProgress[]>{
  const db=await openInitialized(path);try{const query=db.prepare(SELECT+" ORDER BY rowid");query.setReadBigInts(true);return [...query.iterate()].map(read);}finally{db.close();}
}
export async function recordGoalProgressError(path:string,p:PendingGoalProgress,error:string):Promise<void>{
  validText(error);const bounded=takeUnicodeScalarChars(error,1000),thread=p.thread,turn=p.turn,db=await openInitialized(path);
  try{db.prepare("UPDATE codex_goal_progress SET last_error=? WHERE thread=? AND turn=?").run(bounded,thread,turn);}finally{db.close();}
}
export async function completeGoalProgress(path:string,p:PendingGoalProgress):Promise<void>{
  const thread=p.thread,turn=p.turn,db=await openInitialized(path);
  try{db.prepare("DELETE FROM codex_goal_progress WHERE thread=? AND turn=?").run(thread,turn);}finally{db.close();}
}
export function hasPendingGoalProgressIn(db:DatabaseSync,job:string,thread:string):boolean{
  const query=db.prepare("SELECT EXISTS(SELECT 1 FROM codex_goal_progress WHERE job_id=?1 OR (job_id IS NULL AND thread=?2)) AS present");
  query.setReadBigInts(true);return decodeI64(query.get(job,thread)?.present,"pending progress")!==0n;
}
export async function hasPendingGoalProgress(path:string,job:string,thread:string):Promise<boolean>{
  const db=await openInitialized(path);try{return hasPendingGoalProgressIn(db,job,thread);}finally{db.close();}
}
