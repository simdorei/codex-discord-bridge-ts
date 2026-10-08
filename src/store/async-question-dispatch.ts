import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {rustTrim} from "../app-server/value.ts";
import {usingInitializedStore,withStoreTransaction,commitStore} from "./owned-scope.ts";
import {readAsyncQuestionIn,type StoredAsyncQuestion} from "./async-question-read.ts";
import {validateAsyncQuestionMappingIn,asyncQuestionRunningMatches,sealAsyncQuestionIn,verifyAsyncQuestionIdentityIn} from "./async-question-guard.ts";
import {allJobs,QUARANTINED_TURN_PREFIX,QUARANTINED_ERROR_PREFIX} from "./queue-read.ts";
import {enqueueInTransaction} from "./queue-enqueue.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
export interface AsyncQuestionDispatchClaim{readonly id:string;readonly runtime_id:string;readonly generation:bigint;readonly channel:bigint;readonly actor:bigint;readonly message:string;readonly option:bigint;readonly mode:"Steer"|"Start";readonly baseline_turn_ids:readonly string[];readonly prompt:string;readonly now:number}
function text(v:unknown):asserts v is string{if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed question dispatch text");}
const invalid=(message:string):never=>{throw new StoreIntegrityError(message);};
function snapshot(input:AsyncQuestionDispatchClaim):AsyncQuestionDispatchClaim{
 const c=cloneOwnedSerdeValue(input) as AsyncQuestionDispatchClaim;for(const value of [c.id,c.runtime_id,c.message,c.prompt])text(value);
 for(const value of [c.generation,c.channel,c.actor])if(typeof value!=="bigint"||value<-(1n<<63n)||value>=(1n<<63n))throw new TypeError("Expected i64 dispatch identity");
 if(typeof c.option!=="bigint"||c.option<0n||c.option>=(1n<<64n)||typeof c.now!=="number"||(c.mode!=="Steer"&&c.mode!=="Start")||!Array.isArray(c.baseline_turn_ids))throw new TypeError("Expected typed question dispatch claim");for(const value of c.baseline_turn_ids)text(value);return c;
}
/** One-shot durable claim only. Start reserves a quarantined job, never generic retry.
 * The caller still needs exact native generation/turn custody at its final writer. */
export async function beginAsyncQuestionDispatch(path:string,input:AsyncQuestionDispatchClaim):Promise<StoredAsyncQuestion>{
 const c=snapshot(input);return usingInitializedStore(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>{
  const q=readAsyncQuestionIn(db,c.id);
  if(q.runtimeId!==c.runtime_id||q.generation!==c.generation||q.channelId!==c.channel||q.ownerUserId!==c.actor||q.messageId!==c.message||c.option>=BigInt(q.body.options.length)||!Number.isFinite(c.now))invalid("question actor, room, message, connection or option does not match");
  if(q.state!=="open")invalid(`question answer is ${q.state}; no new answer sent. ${q.error}`);
  validateAsyncQuestionMappingIn(db,q);
  const jobs=allJobs(db).filter(job=>job.targetThreadId===q.threadId);let reply:string|null=null;
  if(c.mode==="Start"){
   if(!c.baseline_turn_ids.includes(q.turnId)||c.baseline_turn_ids.some(id=>rustTrim(id)==="")||new Set(c.baseline_turn_ids).size!==c.baseline_turn_ids.length)invalid("async answer requires a complete, unique pre-start baseline");
   if(jobs.length!==0)invalid("original final delivery or later work is still pending; no new turn started");
   reply=`async-question:${q.id}`;enqueueInTransaction(db,{jobId:reply,targetThreadId:q.threadId,channelId:q.channelId,ownerUserId:q.ownerUserId,discordMessageId:null,appServerGeneration:q.generation,prompt:c.prompt,queued:false,ackSent:true,createdAt:c.now});
   db.prepare("UPDATE codex_turn_queue SET state='running',turn_id=?,last_error=?,baseline_turn_ids=? WHERE job_id=?").run(`${QUARANTINED_TURN_PREFIX}async:${q.id}`,`${QUARANTINED_ERROR_PREFIX}async question answer dispatch unconfirmed; no automatic retry`,serializeSerdeValue(c.baseline_turn_ids),reply);
  }else{
   const active=jobs.filter(job=>job.state!=="Pending");if(active.length!==1||!asyncQuestionRunningMatches(active[0]!,q))invalid("the question's exact original running job is no longer owned");
  }
  if(c.option>=(1n<<63n))invalid("invalid option index");
  db.prepare("UPDATE cdr_async_questions SET state='dispatching',chosen=?,dispatch_mode=?,reply_job_id=?,updated_at=? WHERE id=? AND state='open'").run(c.option,c.mode==="Start"?"start":"steer",reply,c.now,c.id);
  sealAsyncQuestionIn(db,c.id);const claimed=readAsyncQuestionIn(db,c.id);return commitStore(claimed);
 }));
}
export async function confirmAsyncQuestionDispatch(path:string,id:string,turn:string):Promise<void>{
 text(id);text(turn);await usingInitializedStore(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>{
  const q=readAsyncQuestionIn(db,id);if(q.state!=="dispatching"||rustTrim(turn)==="")invalid("answer dispatch is not awaiting confirmation");verifyAsyncQuestionIdentityIn(db,id);
  if(q.replyJobId!==null){
   if(turn===q.turnId)invalid("new question reply returned the original turn identity");
   if(BigInt(db.prepare("UPDATE codex_turn_queue SET state='running',turn_id=?,last_error='',updated_at=unixepoch() WHERE job_id=? AND turn_id=? AND app_server_generation=?").run(turn,q.replyJobId,`${QUARANTINED_TURN_PREFIX}async:${q.id}`,q.generation).changes)!==1n)invalid("accepted question reply job changed; outcome held for review");
  }else if(turn!==q.turnId)invalid("steer accepted a different turn");
  db.prepare("UPDATE cdr_async_questions SET state='submitted',accepted_turn_id=?,error='',updated_at=unixepoch() WHERE id=?").run(turn,id);return commitStore(undefined);
 }));
}
export async function recordAsyncQuestionError(path:string,id:string,error:string):Promise<void>{
 text(id);text(error);const bounded=Array.from(error).slice(0,1000).join("");await usingInitializedStore(path,db=>{db.prepare("UPDATE cdr_async_questions SET error=?,updated_at=unixepoch() WHERE id=?").run(bounded,id);});
}
/** Call ONLY for a proved pre-send failure or authoritative rejection, never timeout. */
export async function rejectDefiniteAsyncQuestion(path:string,id:string,error:string):Promise<void>{
 text(id);text(error);const bounded=Array.from(error).slice(0,1000).join("");await usingInitializedStore(path,db=>withStoreTransaction(db,"IMMEDIATE",()=>{
  const q=readAsyncQuestionIn(db,id);if(q.state!=="dispatching")invalid("question dispatch state changed");verifyAsyncQuestionIdentityIn(db,id);
  if(q.replyJobId!==null)db.prepare("DELETE FROM codex_turn_queue WHERE job_id=? AND turn_id=?").run(q.replyJobId,`${QUARANTINED_TURN_PREFIX}async:${q.id}`);
  db.prepare("UPDATE cdr_async_questions SET state='rejected',error=?,updated_at=unixepoch() WHERE id=?").run(bounded,id);return commitStore(undefined);
 }));
}
/** Definite usage-limit rejection has no Reserve/policy dependency. */
export const rejectUsageLimitAsyncQuestion=rejectDefiniteAsyncQuestion;
