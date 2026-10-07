import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {currentStopRevisionIn,targetStopRevisionIn} from "./stop-revision-read.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {decodeI64} from "./sqlite-values.ts";
/** Revokes earlier ordinary RPC metadata; not an interrupt or process-exit receipt. */
export function recordRecoveryCancellationRevisionIn(db:DatabaseSync,target:string,channel:bigint,owner:bigint,jobs:readonly string[],cancelledAt:number):void{
  if(!db.isTransaction)throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  const refused=()=>new StoreIntegrityError("original RPC predates stop or stop revision evidence differs; no dispatch");
  const current=currentStopRevisionIn(db);targetStopRevisionIn(db,target);if(current===(1n<<63n)-1n)throw refused();const revision=current+1n,operation=`recovery-cancel:${randomUUID()}`;
  const scope=serializeSerdeValue({kind:"recovery-cancellation",target,channel,owner,jobs,cancelled_at:cancelledAt});
  if(BigInt(db.prepare("UPDATE cdr_stop_clock SET revision=? WHERE singleton=1 AND revision=?").run(revision,current).changes)!==1n||
    BigInt(db.prepare("INSERT INTO cdr_stop_revision_receipts(operation_id,target_thread_id,revision,scope_json) VALUES(?,?,?,?)").run(operation,target,revision,scope).changes)!==1n||
    BigInt(db.prepare("INSERT INTO cdr_stop_revisions(target_thread_id,revision,operation_id) VALUES(?,?,?) ON CONFLICT(target_thread_id) DO UPDATE SET revision=excluded.revision,operation_id=excluded.operation_id").run(target,revision,operation).changes)!==1n)throw refused();
  const q=db.prepare("SELECT EXISTS(SELECT 1 FROM cdr_stop_revision_receipts WHERE operation_id=? AND target_thread_id=? AND revision=? AND scope_json=?) AS held");q.setReadBigInts(true);
  const retained=decodeI64(q.get(operation,target,revision,scope)?.held,"held")!==0n;
  if(currentStopRevisionIn(db)!==revision||targetStopRevisionIn(db,target)!==revision||!retained)throw refused();
}
