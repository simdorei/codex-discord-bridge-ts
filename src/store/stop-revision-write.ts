import type {DatabaseSync} from "node:sqlite";
import {currentStopRevisionIn,targetStopRevisionIn} from "./stop-revision-read.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeI64} from "./sqlite-values.ts";
export interface StopRevisionReceipt{readonly target:string;readonly revision:bigint;readonly operation:string;readonly scopeJson:string}
const refused=()=>new StoreIntegrityError("original RPC predates stop or stop revision evidence differs; no dispatch");
export function verifyStopRevisionReceiptIn(db:DatabaseSync,record:StopRevisionReceipt):void{
  const q=db.prepare("SELECT EXISTS(SELECT 1 FROM cdr_stop_revision_receipts WHERE operation_id=? AND target_thread_id=? AND revision=? AND scope_json=?) AS held");q.setReadBigInts(true);
  const retained=decodeI64(q.get(record.operation,record.target,record.revision,record.scopeJson)?.held,"held")!==0n;
  if(currentStopRevisionIn(db)!==record.revision||targetStopRevisionIn(db,record.target)!==record.revision||!retained)throw refused();
}
/** Common source DML/verification used by stop and explicit recovery cancellation. */
export function writeStopRevisionReceiptIn(db:DatabaseSync,current:bigint,record:StopRevisionReceipt):void{
  if(!db.isTransaction)throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  if(BigInt(db.prepare("UPDATE cdr_stop_clock SET revision=? WHERE singleton=1 AND revision=?").run(record.revision,current).changes)!==1n||
    BigInt(db.prepare("INSERT INTO cdr_stop_revision_receipts(operation_id,target_thread_id,revision,scope_json) VALUES(?,?,?,?)").run(record.operation,record.target,record.revision,record.scopeJson).changes)!==1n||
    BigInt(db.prepare("INSERT INTO cdr_stop_revisions(target_thread_id,revision,operation_id) VALUES(?,?,?) ON CONFLICT(target_thread_id) DO UPDATE SET revision=excluded.revision,operation_id=excluded.operation_id").run(record.target,record.revision,record.operation).changes)!==1n)throw refused();
  verifyStopRevisionReceiptIn(db,record);
}
