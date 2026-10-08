import {statSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {types} from "node:util";
import {usingExistingStore,withStoreTransaction,commitStore,rollbackStore} from "./owned-scope.ts";
import {jobs,validate,intakeSnapshot,unownedSnapshot,holdPreparing,holdUnowned,claimRecord,advanceAcceptedStopRevisionIn,verifyStopSnapshotsIn,type StopScope,type StopAcceptanceReceipt} from "./stop-acceptance.ts";
import {snapshotStoredIngress} from "./ingress-snapshot.ts";
import type {StoredIngress} from "./ingress-read.ts";
import {selectJob,serializeStoredQueueJob,completionEvidenceGeneration} from "./queue-read.ts";
import {stopHoldSnapshotIn} from "./stop-custody-common.ts";
import {holdIn} from "./execution-hold.ts";
import {verifyStopRevisionReceiptIn} from "./stop-revision-write.ts";
import {serializeStopControl,retainedStopControlIn,type StopControl} from "./stop-control-dispatch.ts";
import {decodeI64} from "./sqlite-values.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import {invokeSynchronousVoid} from "../core/synchronous-void.ts";
import {rustTrim,compareUtf8Bytes} from "./restart-snapshot-pure.ts";
const REASON="user requested stop; original request held, never replay; execution end unconfirmed";
function refused():never{throw new StoreIntegrityError("original stop control authority differs; no interrupt or replay");}
/** Accept durable original Running intent only. No process lookup, interrupt, target
 * lock, schema migration or queue rewrite. Later claim/writer checks remain mandatory. */
export function acceptRunningStop(path:string,input:StopScope,inputBinding:unknown,inputExpected:StoredIngress|null,resident:string,generation:bigint,checkSelected:()=>void,now:()=>number=()=>Date.now()/1000):StopControl|null{
  const s=cloneOwnedSerdeValue(input) as StopScope,binding=cloneOwnedSerdeValue(inputBinding),expected=inputExpected===null?null:snapshotStoredIngress(inputExpected);
  if(typeof path!=="string"||/[\uD800-\uDFFF]/u.test(path)||typeof s.target!=="string"||rustTrim(s.target)===""||typeof resident!=="string"||resident===""||/[\uD800-\uDFFF]/u.test(resident)||[s.channel,s.owner,generation].some(v=>typeof v!=="bigint"||v<=0n||v>=(1n<<63n))||(expected!==null&&expected.phase!=="processing"))refused();
  for(const fn of [checkSelected,now])if(typeof fn!=="function"||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError("Expected synchronous stop custody and clock callbacks");
  try{statSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT"&&expected===null)return null;throw error;}
  return usingExistingStore(path,db=>{db.exec("PRAGMA busy_timeout=500");return withStoreTransaction(db,"IMMEDIATE",()=>{
    validate(db,s,binding,expected);invokeSynchronousVoid(checkSelected,{},[]);const keys=jobs(db,s.target);if(keys.length>128)refused();const originals=keys.map(id=>selectJob(db,id));
    if(!originals.some(j=>j.state==="Running"))return rollbackStore(null);
    if(originals.some(j=>j.channelId!==s.channel||j.ownerUserId!==s.owner||j.state==="Quarantined"))refused();const running=originals.filter(j=>j.state==="Running");if(running.length!==1)refused();const active=running[0]!;if(active.turnId===null||active.turnId==="")refused();
    const q=db.prepare("SELECT EXISTS(SELECT 1 FROM codex_observed_completions WHERE thread_id=? AND turn_id=?) AS terminal");q.setReadBigInts(true);if(decodeI64(q.get(s.target,active.turnId)?.terminal,"terminal")!==0n)refused();
    const preparing=intakeSnapshot(db,s,keys.length),unowned=unownedSnapshot(db,s,keys.length+preparing.length);
    const control:StopControl={operation_id:`stop:${expected?.ingressId??randomUUID()}`,target:s.target,channel:s.channel,owner:s.owner,resident,generation,turn:active.turnId,binding,jobs:originals.map(serializeStoredQueueJob),can_settle:originals.every(j=>(j.state==="Pending"&&j.attemptCount===0n&&j.executionGeneration===null&&j.turnId===null)||(j.jobId===active.jobId&&completionEvidenceGeneration(j)===generation&&!j.goalWaiting))};
    const holds=originals.map(j=>{const wanted=stopHoldSnapshotIn(db,j.jobId)??[s.target,REASON,serializeSerdeValue({kind:"stop",operation_id:control.operation_id,request:parseSerdeValue(serializeStoredQueueJob(j))})] as const;if(wanted[0]!==s.target)refused();holdIn(db,j.jobId,s.target,wanted[1],wanted[2]);return wanted;});
    const preparingHolds=holdPreparing(db,s,preparing,control.operation_id);
    db.prepare("INSERT INTO cdr_stop_controls(operation_id,target_thread_id,resident_owner,generation,turn_id,record_json,phase) VALUES(?,?,?,?,?,?,'accepted')").run(control.operation_id,s.target,resident,generation,control.turn,serializeStopControl(control));
    validate(db,s,binding,expected);const held=holdUnowned(db,unowned,control.operation_id),receipt:StopAcceptanceReceipt={jobs:[...new Set([...keys,...preparing.map(i=>i.jobId)])].sort(compareUtf8Bytes),...(held.length?{ingresses:held.map(i=>i.ingressId)}:{})};
    const claimed=claimRecord(db,expected,receipt,now),revision=advanceAcceptedStopRevisionIn(db,s,binding,receipt,control.operation_id);validate(db,s,binding,claimed);invokeSynchronousVoid(checkSelected,{},[]);
    if(!serdeValueEqual(jobs(db,s.target),keys)||!retainedStopControlIn(db,control))refused();verifyStopSnapshotsIn(db,s,originals,holds,preparing,preparingHolds,held);verifyStopRevisionReceiptIn(db,revision);return commitStore(cloneOwnedSerdeValue(control) as unknown as StopControl);
  });});
}
