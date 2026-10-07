import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { I64_MIN, I64_MAX } from "../protocol/ids.ts";
import { openInitialized } from "./owned-driver.ts";
import { allJobs, serializeStoredQueueJob } from "./queue-read.ts";
import type { StoredQueueJob } from "./queue-read.ts";
import { ensureNoUnresolvedHandoff, ensureSourceNotMoved } from "./fork-handoff-admission.ts";

function text(value: string): string {
  if(typeof value!=="string") throw new TypeError("Expected a well-formed string");
  for(const c of value) {
    const p=c.codePointAt(0)!;
    if(p>=0xd800&&p<=0xdfff) throw new TypeError("Expected a well-formed string");
  }
  return value;
}
function integer(value: bigint): bigint {
  if(typeof value!=="bigint"||value<I64_MIN||value>I64_MAX) throw new TypeError("Expected a signed i64 bigint");
  return value;
}
async function transaction<T>(path: string, run: (db: DatabaseSync)=>T): Promise<T> {
  const db=await openInitialized(text(path));
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result=run(db);
      db.exec("COMMIT");
      return result;
    } catch(error) {
      try { if(db.isTransaction) db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  } finally { try { db.close(); } catch {} }
}
function deleteObserved(db: DatabaseSync, jobs: readonly StoredQueueJob[]): void {
  const stmt=db.prepare("DELETE FROM codex_turn_queue WHERE job_id=? AND app_server_generation=?");
  for(const job of jobs) stmt.run(job.jobId,job.appServerGeneration);
}
export async function complete(path: string, jobId: string): Promise<boolean> {
  const id=text(jobId);
  const db=await openInitialized(text(path));
  try {
    const result=db.prepare(`DELETE FROM codex_turn_queue WHERE job_id=? AND NOT EXISTS
      (SELECT 1 FROM codex_dead_generation_holds hold
       WHERE hold.target_thread_id=codex_turn_queue.target_thread_id)`).run(id);
    return BigInt(result.changes)===1n;
  } finally {try {db.close();} catch {}}
}
export async function discardForGeneration(path: string, currentGeneration: bigint | null): Promise<StoredQueueJob[]> {
  const generation=currentGeneration===null?null:integer(currentGeneration);
  return transaction(path,db=>{
    const jobs=allJobs(db).filter(job=>generation===null||job.appServerGeneration!==generation);
    deleteObserved(db,jobs);
    return jobs;
  });
}
export async function discardObserved(path: string, observed: readonly StoredQueueJob[]): Promise<StoredQueueJob[]> {
  if(!Array.isArray(observed)||types.isProxy(observed)) throw new TypeError("Expected a plain observed array");
  const identities=new Map<string,Set<bigint>>();
  for(let i=0;i<observed.length;i++) {
    const d=Object.getOwnPropertyDescriptor(observed,String(i));
    if(d===undefined||!("value" in d)) throw new TypeError("Expected observed data elements");
    const item=d.value as StoredQueueJob;
    serializeStoredQueueJob(item);
    const id=item.jobId,generation=item.appServerGeneration;
    const generations=identities.get(id)??new Set<bigint>();
    generations.add(generation);identities.set(id,generations);
  }
  return transaction(path,db=>{
    const removed=allJobs(db).filter(job=>identities.get(job.jobId)?.has(job.appServerGeneration)===true);
    deleteObserved(db,removed);
    return removed;
  });
}
export async function flush(path: string, target: string, generation: bigint): Promise<StoredQueueJob[]> {
  const ownedTarget=text(target),ownedGeneration=integer(generation);
  return transaction(path,db=>{
    const jobs=allJobs(db).filter(job=>job.targetThreadId===ownedTarget&&job.appServerGeneration===ownedGeneration);
    deleteObserved(db,jobs);
    return jobs;
  });
}
export async function retract(path: string, target: string, channelId: bigint | null, ownerUserId: bigint | null): Promise<StoredQueueJob | null> {
  const ownedTarget=text(target);
  const channel=channelId===null?null:integer(channelId);
  const owner=ownerUserId===null?null:integer(ownerUserId);
  return transaction(path,db=>{
    ensureNoUnresolvedHandoff(db,ownedTarget);
    ensureSourceNotMoved(db,ownedTarget);
    const selected=allJobs(db).reverse().find(job=>
      job.targetThreadId===ownedTarget&&job.state==="Pending"&&
      (channel===null||job.channelId===channel)&&
      (owner===null||job.ownerUserId===owner));
    if(selected!==undefined) db.prepare("DELETE FROM codex_turn_queue WHERE job_id=?").run(selected.jobId);
    return selected??null;
  });
}
