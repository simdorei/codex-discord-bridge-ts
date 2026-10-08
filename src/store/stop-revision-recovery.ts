import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {currentStopRevisionIn,targetStopRevisionIn} from "./stop-revision-read.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {writeStopRevisionReceiptIn} from "./stop-revision-write.ts";
/** Revokes earlier ordinary RPC metadata; not an interrupt or process-exit receipt. */
export function recordRecoveryCancellationRevisionIn(db:DatabaseSync,target:string,channel:bigint,owner:bigint,jobs:readonly string[],cancelledAt:number):void{
  if(!db.isTransaction)throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  const refused=()=>new StoreIntegrityError("original RPC predates stop or stop revision evidence differs; no dispatch");
  const current=currentStopRevisionIn(db);targetStopRevisionIn(db,target);if(current===(1n<<63n)-1n)throw refused();const revision=current+1n,operation=`recovery-cancel:${randomUUID()}`;
  const scope=serializeSerdeValue({kind:"recovery-cancellation",target,channel,owner,jobs,cancelled_at:cancelledAt});
  writeStopRevisionReceiptIn(db,current,{target,revision,operation,scopeJson:scope});
}
