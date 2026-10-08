import {usingInitializedStore} from "./owned-scope.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed question scope");}
function generation(value:unknown):asserts value is bigint{if(typeof value!=="bigint"||value<-(1n<<63n)||value>=(1n<<63n))throw new TypeError("Expected i64 question generation");}
/** Source has two separately opened, autocommitted operations, not one transaction.
 * Returns only changed selectable-question count. Never expires dispatched authority. */
export async function retireOldAsyncQuestionOwner(path:string,runtime:string,gen:bigint):Promise<bigint>{
  text(runtime);generation(gen);
  await usingInitializedStore(path,db=>{db.prepare("UPDATE cdr_async_question_inbox SET state='expired' WHERE (runtime_id!=? OR generation!=?) AND state='waiting'").run(runtime,gen);});
  return usingInitializedStore(path,db=>BigInt(db.prepare("UPDATE cdr_async_questions SET state='expired',error='original question connection changed; no answer sent',updated_at=unixepoch() WHERE (runtime_id!=? OR generation!=?) AND state IN ('observed','open')").run(runtime,gen).changes));
}
export async function supersedeAsyncQuestions(path:string,runtime:string,gen:bigint,thread:string,turn:string):Promise<bigint>{
  text(runtime);generation(gen);text(thread);text(turn);
  return usingInitializedStore(path,db=>BigInt(db.prepare("UPDATE cdr_async_questions SET state='expired',error='a newer turn superseded this question; no answer sent',updated_at=unixepoch() WHERE runtime_id=? AND generation=? AND thread_id=? AND turn_id!=? AND state IN ('observed','open')").run(runtime,gen,thread,turn).changes));
}
/** Source tombstones keep occurrence IDs. Dispatching/unknown work is never compacted.
 * Preserves two-open partial-success semantics and strict older-than-30-days cutoff. */
export async function compactTerminalAsyncQuestions(path:string,now:number):Promise<bigint>{
  if(typeof now!=="number"||!Number.isFinite(now))throw new StoreIntegrityError("invalid retention clock");
  const cutoff=now-30*86400;
  await usingInitializedStore(path,db=>{db.prepare(`UPDATE cdr_async_question_inbox SET body='{"index":0,"title":"","options":[]}' WHERE state='expired' AND created_at<?`).run(cutoff);});
  return usingInitializedStore(path,db=>BigInt(db.prepare(`UPDATE cdr_async_questions SET body='{"index":0,"title":"","options":[]}',error='terminal question tombstone' WHERE state IN ('submitted','rejected','closed_unknown','unsupported','expired') AND updated_at<? AND body!='{"index":0,"title":"","options":[]}'`).run(cutoff).changes));
}
