import {statSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {types} from "node:util";
import type {DatabaseSync} from "node:sqlite";
import {usingExistingStore,withStoreTransaction,commitStore,rollbackStore} from "./owned-scope.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {validateStopBindingIn,stopHoldSnapshotIn} from "./stop-custody-common.ts";
import {currentStopRevisionIn,targetStopRevisionIn} from "./stop-revision-read.ts";
import {writeStopRevisionReceiptIn,verifyStopRevisionReceiptIn} from "./stop-revision-write.ts";
import {getIngressIn,type StoredIngress} from "./ingress-read.ts";
import {snapshotStoredIngress,storedIngressEqual} from "./ingress-snapshot.ts";
import {getPromptIntakeIn,type StoredPromptIntake} from "./prompt-intake.ts";
import {selectJob,serializeStoredQueueJob,storedQueueJobsEqual} from "./queue-read.ts";
import {holdIn} from "./execution-hold.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {getOwn,isJsonObject,pointer,asI64} from "./async-resolution-json-helpers.ts";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {invokeSynchronousVoid} from "../core/synchronous-void.ts";
import {rustTrim,compareUtf8Bytes} from "./restart-snapshot-pure.ts";
import {SystemTimeError} from "./queue-mark-running.ts";
export interface StopScope{readonly target:string;readonly channel:bigint;readonly owner:bigint}
/** Empty ingresses is omitted, matching the source receipt's serde contract. */
export interface StopAcceptanceReceipt{readonly jobs:readonly string[];readonly ingresses?:readonly string[]}
const REASON="user requested stop; original request held, never replay; execution end unconfirmed";
function refused():never{throw new StoreIntegrityError("stop custody differs or could not be preserved; no stop acceptance");}
function equal(a:unknown,b:unknown):boolean{return serdeValueEqual(a,b);}
function ids(db:DatabaseSync,table:string,column:string,target:string,extra=""):string[]{
  const q=db.prepare(`SELECT ${column},CAST(${column} AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM ${table} WHERE target_thread_id=? ${extra} ORDER BY ${column} LIMIT 129`);
  return q.all(target).map(r=>decodeTextField(r[column],r.raw,column,false,textDecoderFor(r.encoding))!);
}
function jobs(db:DatabaseSync,target:string):string[]{return ids(db,"codex_turn_queue","job_id",target);}
function intakeIds(db:DatabaseSync,target:string):string[]{return ids(db,"codex_prompt_intakes","job_id",target);}
function unownedIds(db:DatabaseSync,target:string):string[]{return ids(db,"discord_ingress_journal","ingress_id",target,`AND owner_id IS NULL AND state IN ('staged','acknowledged','executing','held')
  AND json_type(payload_json,'$.version')='integer' AND json_extract(payload_json,'$.version')=1 AND (
  (kind='message' AND (json_type(payload_json,'$.plan.Execute.Ask.prompt')='text' OR json_type(payload_json,'$.plan.Execute.Interview.prompt')='text')) OR
  (kind='interaction' AND json_extract(payload_json,'$.work.Slash.name') IN ('ask','interview') AND json_type(payload_json,'$.work.Slash.values.prompt.String')='text'))`);}
function validate(db:DatabaseSync,s:StopScope,binding:unknown,expected:StoredIngress|null):void{
  validateStopBindingIn(db,s.target,s.channel,binding);if(expected===null)return;
  const actual=getIngressIn(db,expected.ingressId),event=expected.eventId;
  if(actual===null||!storedIngressEqual(actual,expected)||event===null||event<=0n||expected.kind!=="message"||expected.ingressId!==`message:${event}`||expected.sourceMessageId!==event||expected.channelId!==s.channel||expected.ownerUserId!==s.owner||expected.state!=="executing"||expected.ownerId!==null||expected.ownerKind!==null||expected.targetThreadId!==s.target||getOwn(expected.payload,"version")!==1n||!equal(getOwn(expected.payload,"lifecycle_binding"),binding)||!equal(pointer(expected.payload,"/plan/Execute"),getOwn(binding,"command")))refused();
}
function intakeSnapshot(db:DatabaseSync,s:StopScope,queued:number):StoredPromptIntake[]{
  const keys=intakeIds(db,s.target);if(queued+keys.length>128)refused();return keys.map(id=>{const value=getPromptIntakeIn(db,id);if(value===null||value.channelId!==s.channel||value.ownerUserId!==s.owner||value.targetThreadId!==s.target)refused();return value;});
}
function unownedSnapshot(db:DatabaseSync,s:StopScope,already:number):StoredIngress[]{
  const keys=unownedIds(db,s.target);if(already+keys.length>128)refused();return keys.map(id=>{const value=getIngressIn(db,id);if(value===null||value.channelId!==s.channel||value.ownerUserId!==s.owner||value.eventId===null||value.eventId<=0n||value.ownerKind!==null||value.ownerId!==null)refused();return value;});
}
function holdPreparing(db:DatabaseSync,s:StopScope,originals:StoredPromptIntake[],operation:string|null){return originals.map(i=>{
  const wanted=stopHoldSnapshotIn(db,i.jobId)??[s.target,REASON,serializeSerdeValue({kind:"stop_preparing",operation_id:operation,job_id:i.jobId,target_thread_id:i.targetThreadId,channel_id:i.channelId,owner_user_id:i.ownerUserId,discord_message_id:i.discordMessageId,claim_token:i.claimToken})] as const;
  if(wanted[0]!==s.target)refused();holdIn(db,i.jobId,s.target,wanted[1],wanted[2]);return wanted;
});}
function holdUnowned(db:DatabaseSync,originals:StoredIngress[],operation:string):StoredIngress[]{return originals.map(original=>{
  const outcome=original.outcome===undefined?{}:cloneOwnedSerdeValue(original.outcome);if(!isJsonObject(outcome))refused();const previous=getOwn(outcome,"stop_hold");
  if(previous!==undefined){if(original.state!=="held"||getOwn(previous,"kind")!=="stop_original_ingress"||getOwn(previous,"ingress_id")!==original.ingressId||getOwn(previous,"target")!==original.targetThreadId||getOwn(previous,"channel")!==original.channelId||getOwn(previous,"owner")!==original.ownerUserId||asI64(getOwn(previous,"event_id"))!==original.eventId)refused();return original;}
  const evidence={kind:"stop_original_ingress",ingress_id:original.ingressId,target:original.targetThreadId,channel:original.channelId,owner:original.ownerUserId,event_id:original.eventId,operation_id:operation};
  const wanted:StoredIngress={...original,state:"held",holdReason:original.holdReason===""?REASON:original.holdReason,outcome:{...outcome,stop_hold:evidence}};
  if(BigInt(db.prepare("UPDATE discord_ingress_journal SET state='held',hold_reason=?,outcome_json=json_set(COALESCE(outcome_json,'{}'),'$.stop_hold',json(?)) WHERE ingress_id=? AND owner_id IS NULL").run(wanted.holdReason,serializeSerdeValue(evidence),original.ingressId).changes)!==1n)refused();
  const actual=getIngressIn(db,original.ingressId);if(actual===null||!storedIngressEqual(actual,wanted))refused();return wanted;
});}
function claimRecord(db:DatabaseSync,expected:StoredIngress|null,receipt:StopAcceptanceReceipt,now:()=>number):StoredIngress|null{
  if(expected===null)return null;const time=now();if(typeof time!=="number"||!Number.isFinite(time)||time<0)throw new SystemTimeError(-time*1000);
  const claimed:StoredIngress={...expected,phase:"stop_accepted",updatedAt:time,outcome:{kind:"stop_accepted",jobs:receipt.jobs,ingresses:receipt.ingresses??[],execution_end_confirmed:false}};
  if(BigInt(db.prepare("UPDATE discord_ingress_journal SET phase=?,outcome_json=?,updated_at=? WHERE ingress_id=? AND state='executing' AND phase='processing' AND owner_id IS NULL").run(claimed.phase,serializeSerdeValue(claimed.outcome),time,claimed.ingressId).changes)!==1n)refused();return claimed;
}
/** Existing-only 500ms IMMEDIATE transaction; no migration, target mutex, RPC,
 * queue rewrite, active-turn inference or process-exit claim. checkSelected is
 * mandatory trusted synchronous custody and is called before and after writes. */
function accept(path:string,input:StopScope,inputBinding:unknown,inputExpected:StoredIngress|null,checkSelected:()=>void,allowUncertain:boolean,now:()=>number):StopAcceptanceReceipt|null{
  const s=cloneOwnedSerdeValue(input) as StopScope,binding=cloneOwnedSerdeValue(inputBinding),expected=inputExpected===null?null:snapshotStoredIngress(inputExpected);
  if(typeof path!=="string"||/[\uD800-\uDFFF]/u.test(path)||typeof s.target!=="string"||rustTrim(s.target)===""||[s.channel,s.owner].some(v=>typeof v!=="bigint"||v<=0n||v>=(1n<<63n))||(expected!==null&&expected.phase!=="processing"))refused();
  for(const fn of [checkSelected,now])if(typeof fn!=="function"||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError("Expected synchronous stop custody and clock callbacks");
  try{statSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT"&&expected===null)return null;throw new StoreIntegrityError("stop database unavailable");}
  return usingExistingStore(path,db=>{db.exec("PRAGMA busy_timeout=500");return withStoreTransaction(db,"IMMEDIATE",()=>{
    validate(db,s,binding,expected);invokeSynchronousVoid(checkSelected,{},[]);const keys=jobs(db,s.target),preparing=intakeSnapshot(db,s,keys.length),unowned=unownedSnapshot(db,s,keys.length+preparing.length);if(keys.length>128)refused();
    const originals=keys.map(id=>selectJob(db,id));if(originals.some(job=>job.channelId!==s.channel||job.ownerUserId!==s.owner))refused();
    if(!allowUncertain&&((originals.length===0&&preparing.length===0&&unowned.length===0)||originals.some(job=>job.state!=="Pending"&&job.state!=="Starting")))return rollbackStore(null);
    const holds=originals.map(job=>{const wanted=stopHoldSnapshotIn(db,job.jobId)??[s.target,REASON,serializeSerdeValue({kind:"stop",request:parseSerdeValue(serializeStoredQueueJob(job)),ingress_id:expected?.ingressId??null})] as const;if(wanted[0]!==s.target)refused();holdIn(db,job.jobId,s.target,wanted[1],wanted[2]);return wanted;});
    validate(db,s,binding,expected);const preparingHolds=holdPreparing(db,s,preparing,expected?.ingressId??null),operation=`stop:${expected?.ingressId??randomUUID()}`,held=holdUnowned(db,unowned,operation);
    const receipt:StopAcceptanceReceipt={jobs:[...new Set([...keys,...preparing.map(i=>i.jobId)])].sort(compareUtf8Bytes),...(held.length?{ingresses:held.map(r=>r.ingressId)}:{})};const claimed=claimRecord(db,expected,receipt,now);
    const current=currentStopRevisionIn(db);targetStopRevisionIn(db,s.target);if(current===(1n<<63n)-1n)throw new StoreIntegrityError("original RPC predates stop or stop revision evidence differs; no dispatch");
    const q=db.prepare("SELECT EXISTS(SELECT 1 FROM codex_prompt_intakes WHERE target_thread_id=?) AS present");q.setReadBigInts(true);const record={target:s.target,revision:current+1n,operation,scopeJson:serializeSerdeValue({target:s.target,channel:s.channel,owner:s.owner,hadPreparing:decodeI64(q.get(s.target)?.present,"present")!==0n,binding,jobs:receipt.jobs,ingresses:receipt.ingresses??[]})};writeStopRevisionReceiptIn(db,current,record);
    validate(db,s,binding,claimed);invokeSynchronousVoid(checkSelected,{},[]);if(!equal(jobs(db,s.target),keys))refused();
    for(let i=0;i<originals.length;i++){const job=originals[i]!;if(!storedQueueJobsEqual(selectJob(db,job.jobId),job)||!equal(stopHoldSnapshotIn(db,job.jobId),holds[i]))refused();}
    if(!equal(intakeIds(db,s.target),preparing.map(i=>i.jobId)))refused();for(let i=0;i<preparing.length;i++){const item=preparing[i]!,actual=getPromptIntakeIn(db,item.jobId);if(actual===null||!equal(actual,item)||!equal(stopHoldSnapshotIn(db,item.jobId),preparingHolds[i]))refused();}
    if(!equal(unownedIds(db,s.target),held.map(r=>r.ingressId)))refused();for(const original of held){const actual=getIngressIn(db,original.ingressId);if(actual===null||!storedIngressEqual(actual,original))refused();}
    verifyStopRevisionReceiptIn(db,record);return commitStore(cloneOwnedSerdeValue(receipt) as StopAcceptanceReceipt);
  });});
}
export function acceptNonrunningStop(path:string,scope:StopScope,binding:unknown,expected:StoredIngress|null,checkSelected:()=>void,now:()=>number=()=>Date.now()/1000):StopAcceptanceReceipt|null{return accept(path,scope,binding,expected,checkSelected,false,now);}
export function acceptUnresolvedStop(path:string,scope:StopScope,binding:unknown,expected:StoredIngress|null,checkSelected:()=>void,now:()=>number=()=>Date.now()/1000):StopAcceptanceReceipt|null{return accept(path,scope,binding,expected,checkSelected,true,now);}
