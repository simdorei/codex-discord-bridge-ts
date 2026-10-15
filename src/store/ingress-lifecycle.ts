import {newThreadOriginIn} from "./new-thread-origin.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import type {DatabaseSync,SQLInputValue} from "node:sqlite";
import {openInitialized,verifyCurrentCatalogIn} from "./owned-driver.ts";
import {usingExistingStore,withStoreTransaction,commitStore} from "./owned-scope.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {InvalidAppServerManagedTargetError} from "./queue-managed-target.ts";
import {getIngressIn} from "./ingress-read.ts";
import {frozenSlashTarget,newExecutionPrompt} from "./ingress-new-input.ts";
import {mirroredThreadIdIn} from "./busy-choice.ts";
import {getIn as newReplyIn} from "./new-reply-read.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {getOwn,isJsonObject} from "./async-resolution-json-helpers.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {trimUnicodeWhitespace as trim} from "./queue-preflight-failure.ts";
export class RequestCancelledError extends Error{
  readonly kind="RequestCancelled";readonly ingressId:string;
  constructor(key:string){super(`request ${key} was cancelled by its original sender; a late result cannot replace the cancellation`);this.name="RequestCancelledError";this.ingressId=key;}
}
function text(v:unknown):void{if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed text");}
function time(v:unknown):void{if(typeof v!=="number")throw new TypeError("Expected numeric timestamp");}
function generation(v:unknown):void{if(typeof v!=="bigint"||v<-(1n<<63n)||v>=(1n<<63n))throw new TypeError("Expected i64 generation");}
async function connection<T>(path:string,transaction:boolean,run:(db:DatabaseSync)=>T):Promise<T>{
  text(path);const db=await openInitialized(path);try{if(transaction)db.exec("BEGIN IMMEDIATE");const result=run(db);if(transaction)db.exec("COMMIT");return result;}
  finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}
function changed(db:DatabaseSync,sql:string,...values:SQLInputValue[]):boolean{return BigInt(db.prepare(sql).run(...values).changes)===1n;}
function acknowledgeIngressBody(db:DatabaseSync,key:string,now:number):boolean{
  return changed(db,"UPDATE discord_ingress_journal SET state='acknowledged',phase='acknowledged',updated_at=? WHERE ingress_id=? AND state='staged'",now,key);
}
export function acknowledgeIngress(path:string,key:string,now:number):Promise<boolean>{
  text(key);time(now);return connection(path,false,db=>acknowledgeIngressBody(db,key,now));
}
export function acknowledgeIngressExisting(path:string,key:string,now:number):boolean{
  text(key);time(now);return existingConnection(path,false,db=>acknowledgeIngressBody(db,key,now));
}
function beginIngressConfirmationBody(db:DatabaseSync,key:string,now:number):boolean{
  return changed(db,"UPDATE discord_ingress_journal SET phase='confirmation_retry',updated_at=? WHERE ingress_id=? AND state='owned' AND phase='canonical_duplicate' AND owner_kind='prompt'",now,key);
}
export function beginIngressConfirmation(path:string,key:string,now:number):Promise<boolean>{
  text(key);time(now);return connection(path,false,db=>beginIngressConfirmationBody(db,key,now));
}
export function beginIngressConfirmationExisting(path:string,key:string,now:number):boolean{
  text(key);time(now);return existingConnection(path,false,db=>beginIngressConfirmationBody(db,key,now));
}
export function captureIngressExecution(key:string,phase:string,target:string|null,now:number){
  text(key);text(phase);if(target!==null)text(target);time(now);return {key,phase,target,now};
}
function beginIngressExecutionBody(db:DatabaseSync,key:string,phase:string,target:string|null,now:number):boolean{
    const record=getIngressIn(db,key),original=record===null?null:frozenSlashTarget(record);
    if(original!==null&&((target!==null&&target!==original)||mirroredThreadIdIn(db,record!.channelId)!==original))throw new StoreIntegrityError("original slash prompt mapping changed; no execution was claimed");
    return changed(db,"UPDATE discord_ingress_journal SET state='executing',phase=?,target_thread_id=COALESCE(?,target_thread_id),updated_at=? WHERE ingress_id=? AND state IN ('staged','acknowledged')",phase,target,now,key);
}
export function beginIngressExecution(path:string,key:string,phase:string,target:string|null,now:number):Promise<boolean>{
  const q=captureIngressExecution(key,phase,target,now);return connection(path,true,db=>beginIngressExecutionBody(db,q.key,q.phase,q.target,q.now));
}
/** Existing-only native leaf, sharing the original IMMEDIATE body. */
export function beginIngressExecutionExisting(path:string,key:string,phase:string,target:string|null,now:number):boolean{
  const q=captureIngressExecution(key,phase,target,now);return existingConnection(path,true,db=>beginIngressExecutionBody(db,q.key,q.phase,q.target,q.now));
}
export function captureIngressThreadStart(key:string,gen:bigint,now:number){
  text(key);generation(gen);time(now);if(gen<=0n)throw new StoreIntegrityError("invalid thread/start generation");return {key,gen,now};
}
function beginIngressThreadStartBody(db:DatabaseSync,key:string,gen:bigint,now:number):boolean{
    const record=getIngressIn(db,key);if(record!==null&&newExecutionPrompt(record)===null)throw new StoreIntegrityError("thread/start has no original New input");
    return changed(db,"UPDATE discord_ingress_journal SET state='executing',phase='thread/start',target_thread_id=NULL,outcome_json=json_set(COALESCE(outcome_json,'{}'),'$.thread_start_generation',?),updated_at=? WHERE ingress_id=? AND (state IN ('staged','acknowledged') OR (state='executing' AND phase='processing'))",gen,now,key);
}
export function beginIngressThreadStart(path:string,key:string,gen:bigint,now:number):Promise<boolean>{
 const q=captureIngressThreadStart(key,gen,now);return connection(path,true,db=>beginIngressThreadStartBody(db,q.key,q.gen,q.now));
}
/** Existing current store only; original statement/transaction body is shared. */
export function beginIngressThreadStartExisting(path:string,key:string,gen:bigint,now:number):boolean{
 const q=captureIngressThreadStart(key,gen,now);return usingExistingStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{verifyCurrentCatalogIn(db);return commitStore(beginIngressThreadStartBody(db,q.key,q.gen,q.now));}));
}

export function captureIngressCreatedThread(key:string,gen:bigint,target:string,now:number){
  text(key);generation(gen);text(target);time(now);if(trim(target)===""||trim(target)!==target)throw new InvalidAppServerManagedTargetError(target);return {key,gen,target,now};
}
function recordIngressCreatedThreadBody(db:DatabaseSync,key:string,gen:bigint,target:string,now:number):void{
    if(!changed(db,"UPDATE discord_ingress_journal SET phase='thread/created',target_thread_id=?,updated_at=? WHERE ingress_id=? AND state='executing' AND phase='thread/start' AND json_extract(outcome_json,'$.thread_start_generation')=?",target,now,key,gen))throw new StoreIntegrityError("created thread has no matching generation-bound attempt");
}
export function recordIngressCreatedThread(path:string,key:string,gen:bigint,target:string,now:number):Promise<void>{
 const q=captureIngressCreatedThread(key,gen,target,now);return connection(path,false,db=>recordIngressCreatedThreadBody(db,q.key,q.gen,q.target,q.now));
}
/** Existing current store only; original statement/transaction body is shared. */
export function recordIngressCreatedThreadExisting(path:string,key:string,gen:bigint,target:string,now:number):void{
 const q=captureIngressCreatedThread(key,gen,target,now);return usingExistingStore(path,db=>{withStoreTransaction(db,'DEFERRED',()=>{verifyCurrentCatalogIn(db);return commitStore(undefined);});return recordIngressCreatedThreadBody(db,q.key,q.gen,q.target,q.now);});
}

export function captureIngressResult(key:string,input:unknown,now:number){
  text(key);time(now);return {key,outcome:parseSerdeValue(serializeSerdeValue(input)),now};
}
function recordIngressResultBody(db:DatabaseSync,key:string,outcome:unknown,now:number):void{
    const record=getIngressIn(db,key);if(record===null)throw new StoreIntegrityError(`missing ingress result: ${key}`);
    if(record.phase==="cancelled"){
      const q=db.prepare("SELECT EXISTS(SELECT 1 FROM codex_request_cancellations WHERE job_id=? AND target_thread_id=? AND owner_user_id=?) AS held");q.setReadBigInts(true);
      if(decodeI64(q.get(record.ownerId,record.targetThreadId,record.ownerUserId)?.held,"held")!==0n)throw new RequestCancelledError(key);
    }
    let stopReceipt:unknown;
    if(record.phase==="stop_accepted"){if(!isJsonObject(record.outcome))throw new StoreIntegrityError("stop acceptance evidence is missing");stopReceipt=record.outcome;}
    else stopReceipt=getOwn(record.outcome,"stop_receipt");
    if(stopReceipt!==undefined){if(!isJsonObject(outcome))throw new StoreIntegrityError("result must preserve stop acceptance evidence");outcome.stop_receipt=stopReceipt;}
    for(const field of ["new_creation","new_verification","new_input"]){const saved=getOwn(record.outcome,field);if(saved!==undefined){if(!isJsonObject(outcome))throw new StoreIntegrityError("new result must preserve creation evidence");outcome[field]=saved;}}
    if(!changed(db,"UPDATE discord_ingress_journal SET state=CASE WHEN owner_id IS NULL THEN 'completed' ELSE 'owned' END,phase='result_recorded',outcome_json=?,updated_at=? WHERE ingress_id=? AND state <> 'held'",serializeSerdeValue(outcome),now,key))throw new StoreIntegrityError(`ingress result cannot be recorded: ${key}`);
}
export function recordIngressResult(path:string,key:string,input:unknown,now:number):Promise<void>{
  const q=captureIngressResult(key,input,now);return connection(path,true,db=>recordIngressResultBody(db,q.key,q.outcome,q.now));
}
export function recordIngressResultExisting(path:string,key:string,input:unknown,now:number):void{
  const q=captureIngressResult(key,input,now);return existingConnection(path,true,db=>recordIngressResultBody(db,q.key,q.outcome,q.now));
}
function confirmIngressFirstReplyBody(db:DatabaseSync,key:string):void{
    const row=db.prepare("SELECT job_id,CAST(job_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM codex_new_first_replies WHERE ingress_id=?").get(key);
    if(row!==undefined){const job=decodeTextField(row.job_id,row.raw,"job_id",false,textDecoderFor(row.encoding))!,record=newReplyIn(db,job);
      if(record!==null&&!record.confirmationDelivered&&record.identity.kind!=="action")throw new StoreIntegrityError("new first reply cannot be confirmed without its normal acknowledgement receipt");}
}
function confirmIngressOutcomeBody(db:DatabaseSync,key:string,now:number):void{
  if(!changed(db,"UPDATE discord_ingress_journal SET confirmation_delivered=1,updated_at=? WHERE ingress_id=? AND state IN ('completed','owned')",now,key))throw new StoreIntegrityError(`ingress confirmation has no outcome: ${key}`);
}
/** Retains source's separate first-reply lookup and outcome update; not a new atomic acknowledgement guarantee. */
export async function confirmIngress(path:string,key:string,now:number):Promise<void>{
  text(key);time(now);await connection(path,false,db=>confirmIngressFirstReplyBody(db,key));
  await connection(path,false,db=>confirmIngressOutcomeBody(db,key,now));
}
/** Deliberately TWO existing connections and no combined transaction. */
export function confirmIngressExisting(path:string,key:string,now:number):void{
  text(key);time(now);existingConnection(path,false,db=>confirmIngressFirstReplyBody(db,key));
  existingConnection(path,false,db=>confirmIngressOutcomeBody(db,key,now));
}
function recordIngressProcessingModeBody(db:DatabaseSync,key:string,mode:string):void{
    const record=getIngressIn(db,key);if(record===null)throw new StoreIntegrityError("missing admitted message custody");if(record.state!=="staged")throw new StoreIntegrityError("message processing mode already frozen");
    if(!isJsonObject(record.payload))throw new StoreIntegrityError("admitted message payload is not an object");record.payload.processing_mode=mode;
    db.prepare("UPDATE discord_ingress_journal SET payload_json=? WHERE ingress_id=?").run(serializeSerdeValue(record.payload),key);
}
export function recordIngressProcessingMode(path:string,key:string,mode:string):Promise<void>{
  text(key);text(mode);return connection(path,true,db=>recordIngressProcessingModeBody(db,key,mode));
}
export function recordIngressProcessingModeExisting(path:string,key:string,mode:string):void{
  text(key);text(mode);return existingConnection(path,true,db=>recordIngressProcessingModeBody(db,key,mode));
}
/** Catalog validation does not turn a source autocommit operation into a new transaction. */
function existingConnection<T>(path:string,transaction:boolean,run:(db:DatabaseSync)=>T):T{
  text(path);return usingExistingStore(path,db=>{
    if(transaction)return withStoreTransaction(db,'IMMEDIATE',()=>{verifyCurrentCatalogIn(db);return commitStore(run(db));});
    withStoreTransaction(db,'DEFERRED',()=>{verifyCurrentCatalogIn(db);return commitStore(undefined);});return run(db);
  });
}

/** Resolved context belongs only to the matching original thread/start attempt. */
export function captureIngressNewCreation(key:string,gen:bigint,cwd:string|null,channel:bigint,now:number){
  text(key);generation(gen);generation(channel);if(cwd!==null)text(cwd);time(now);
  if((cwd!==null&&trim(cwd)==="")||channel<=0n)throw new StoreIntegrityError("invalid new creation context");
  return {key,gen,cwd,channel,now};
}
function recordIngressNewCreationBody(db:DatabaseSync,key:string,gen:bigint,context:{version:bigint;cwd:string|null;origin_channel_id:bigint},channel:bigint,now:number):void{
    const record=getIngressIn(db,key);if(record===null)throw new StoreIntegrityError("new creation ingress is missing");
    const origin=newThreadOriginIn(db,channel);
    if(!serdeValueEqual(getOwn(record.payload,"new_origin"),origin))throw new StoreIntegrityError("new origin mapping changed after classification/admission; no thread/start permitted");
    if(!changed(db,"UPDATE discord_ingress_journal SET outcome_json=json_set(outcome_json,'$.new_creation',json(?)),updated_at=? WHERE ingress_id=? AND state='executing' AND phase='thread/start' AND json_extract(outcome_json,'$.thread_start_generation')=? AND json_type(outcome_json,'$.new_creation') IS NULL AND channel_id=?",serializeSerdeValue(context),now,key,gen,channel))throw new StoreIntegrityError("new creation context has no matching unwritten attempt");
}
export function recordIngressNewCreation(path:string,key:string,gen:bigint,cwd:string|null,channel:bigint,now:number):Promise<void>{
 const q=captureIngressNewCreation(key,gen,cwd,channel,now);return connection(path,true,db=>recordIngressNewCreationBody(db,q.key,q.gen,{version:1n,cwd:q.cwd,origin_channel_id:q.channel},q.channel,q.now));
}
/** Existing current store only; original statement/transaction body is shared. */
export function recordIngressNewCreationExisting(path:string,key:string,gen:bigint,cwd:string|null,channel:bigint,now:number):void{
 const q=captureIngressNewCreation(key,gen,cwd,channel,now);return usingExistingStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{verifyCurrentCatalogIn(db);return commitStore(recordIngressNewCreationBody(db,q.key,q.gen,{version:1n,cwd:q.cwd,origin_channel_id:q.channel},q.channel,q.now));}));
}

