import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {targetIsHeldIn} from "./dead-generation-admission.ts";
import {DeadGenerationTargetHeldError} from "./fork-completed-target.ts";
import {receiptRow,receiptText,receiptTextColumns,receiptExists} from "./delivery-receipt-key.ts";
import {decodeI64} from "./sqlite-values.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
export interface PendingCommentary{readonly sequence:bigint;readonly jobId:string;readonly threadId:string;readonly turnId:string;readonly channelId:bigint;readonly text:string}
const columns=`sequence,job_id,target_thread_id,turn_id,channel_id,text,${receiptTextColumns("job_id","target_thread_id","turn_id","text")}`;
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed commentary text");}
function i64(value:unknown):asserts value is bigint{if(typeof value!=="bigint"||value<-(1n<<63n)||value>=(1n<<63n))throw new TypeError("Expected i64 commentary sequence");}
function read(row:Record<string,unknown>|undefined):PendingCommentary{
  if(row===undefined)throw new StoreIntegrityError("Missing staged commentary");
  return {sequence:decodeI64(row.sequence,"sequence"),jobId:receiptText(row,"job_id")!,threadId:receiptText(row,"target_thread_id")!,turnId:receiptText(row,"turn_id")!,channelId:decodeI64(row.channel_id,"channel_id"),text:receiptText(row,"text")!};
}
/** Running owner is captured and progress saved in one immediate transaction, before I/O. */
export async function stageCommentary(path:string,thread:string,turn:string,input:string):Promise<PendingCommentary|null>{
  for(const value of [path,thread,turn,input])text(value);
  const db=await openInitialized(path);let committed=false;
  try{
    db.exec("BEGIN IMMEDIATE");
    const owner=receiptRow(db,`SELECT job_id,channel_id,${receiptTextColumns("job_id")} FROM codex_turn_queue WHERE target_thread_id=? AND turn_id=? AND state='running'`,thread,turn);
    if(owner===undefined)return null;
    const job=receiptText(owner,"job_id")!,channel=decodeI64(owner.channel_id,"channel_id");
    if(targetIsHeldIn(db,thread))throw new DeadGenerationTargetHeldError(thread);
    const content=input.replace(/^\p{White_Space}+/u,"").replace(/\p{White_Space}+$/u,"");
    const key=createHash("sha256").update(serializeSerdeValue([thread,turn,content])).digest("hex");
    db.prepare("INSERT OR IGNORE INTO codex_commentary_outbox(delivery_key,job_id,target_thread_id,turn_id,channel_id,text) VALUES (?,?,?,?,?,?)").run(key,job,thread,turn,channel,content);
    const pending=read(receiptRow(db,`SELECT ${columns} FROM codex_commentary_outbox WHERE delivery_key=?`,key));
    db.exec("COMMIT");committed=true;return pending;
  }finally{if(!committed&&db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close abandons transaction */}}db.close();}
}
export async function pendingCommentary(path:string):Promise<PendingCommentary[]>{
  text(path);const db=await openInitialized(path);try{
    const q=db.prepare(`SELECT ${columns} FROM codex_commentary_outbox ORDER BY sequence`);q.setReadBigInts(true);
    return Array.from(q.iterate(),read);
  }finally{db.close();}
}
export function hasPendingCommentaryIn(db:DatabaseSync,job:string,before:bigint|null=null):boolean{
  text(job);if(before!==null)i64(before);
  return receiptExists(db,"SELECT EXISTS(SELECT 1 FROM codex_commentary_outbox WHERE job_id=?1 AND (?2 IS NULL OR sequence<?2)) AS held",job,before);
}
export async function hasPendingCommentary(path:string,job:string,before:bigint|null=null):Promise<boolean>{
  text(path);text(job);if(before!==null)i64(before);const db=await openInitialized(path);try{return hasPendingCommentaryIn(db,job,before);}finally{db.close();}
}
export async function completeCommentary(path:string,sequence:bigint):Promise<void>{
  text(path);i64(sequence);const db=await openInitialized(path);try{db.prepare("DELETE FROM codex_commentary_outbox WHERE sequence=?").run(sequence);}finally{db.close();}
}
