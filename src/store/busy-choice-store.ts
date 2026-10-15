import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {withPromptIntakeWriter,withPromptIntakeWriterExisting} from "./prompt-intake.ts";
import {openInitialized,verifyCurrentCatalogIn} from "./owned-driver.ts";
import {usingExistingStore,withStoreTransaction,rollbackStore} from "./owned-scope.ts";
import {snapshotBusyChoice,busyChoiceDataField,mirroredThreadIdIn,verifyBusyChoiceRouteIn,type BusyChoice} from "./busy-choice.ts";
import {decodeI64,decodeTimestamp,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
export interface NewBusyChoice {ownerUserId:bigint;channelId:bigint;targetThreadId:string|null;prompt:string;allowSteer:boolean;now:number;timeToLive:number}
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed text");}
function timestamp(value:unknown):asserts value is number{if(typeof value!=="number")throw new TypeError("Expected numeric timestamp");}
function captureNewBusyChoice(input:NewBusyChoice):BusyChoice{
  // NewBusyChoice is snapshotted through the same stable choice validator.
  const value=(key:string)=>busyChoiceDataField(input,key);
  const choice=snapshotBusyChoice({choiceId:"",ownerUserId:value("ownerUserId"),channelId:value("channelId"),targetThreadId:value("targetThreadId"),
    prompt:value("prompt"),allowSteer:value("allowSteer"),createdAt:value("now"),expiresAt:value("timeToLive")} as BusyChoice);
  return choice;
}
function insertBusyChoiceIn(db:DatabaseSync,choice:BusyChoice,expected:boolean|null,originalId:string|null):string{
    const current=mirroredThreadIdIn(db,choice.channelId),mapped=expected??(current!==null);
    verifyBusyChoiceRouteIn(db,choice.channelId,choice.targetThreadId,mapped);
    db.prepare("DELETE FROM busy_choices WHERE expires_at<=?").run(choice.createdAt);
    const id=originalId??randomUUID().replaceAll("-","").slice(0,24);
    db.prepare(`INSERT INTO busy_choices(choice_id,owner_user_id,channel_id,target_thread_id,prompt,allow_steer,created_at,expires_at,claimed_at,require_current_mirror)
      VALUES (?,?,?,?,?,?,?,?,NULL,?)`).run(id,choice.ownerUserId,choice.channelId,choice.targetThreadId,choice.prompt,Number(choice.allowSteer),choice.createdAt,choice.createdAt+choice.expiresAt,Number(mapped));
    return id;
}
/** null route means infer the original mapping, not an unknown stored legacy route. */
export async function createBusyChoice(path:string,input:NewBusyChoice,expected:boolean|null=null):Promise<string>{
  const choice=captureNewBusyChoice(input);
  if(expected!==null&&typeof expected!=="boolean")throw new TypeError("Expected optional route mode");
  return withPromptIntakeWriter(path,db=>({value:insertBusyChoiceIn(db,choice,expected,null),commit:true}),false);
}
/** Existing runtime only; caller owns this original ID for uncertain-commit
 * reconciliation. Keep expiry cleanup and insertion in their original transaction. */
export function createBusyChoiceExisting(path:string,input:NewBusyChoice,expected:boolean,id:string):string{
  const choice=captureNewBusyChoice(input);if(typeof expected!=="boolean"||typeof id!=="string"||!/^[a-f0-9]{24}$/.test(id))throw new TypeError("Expected original busy choice identity");
  return withPromptIntakeWriterExisting(path,db=>{
    insertBusyChoiceIn(db,choice,expected,id);
    verifyCreatedBusyChoiceIn(db,id,input,expected);
    return {value:id,commit:true};
  });
}

/** Same transaction readback for the native owner, including binding triggers. */
export function verifyCreatedBusyChoiceIn(db:DatabaseSync,id:string,input:NewBusyChoice,expected:boolean):void{
    const choice=captureNewBusyChoice(input);
    const saved=readBusyChoiceRow(db,id),route=db.prepare("SELECT require_current_mirror,allow_steer FROM busy_choices WHERE choice_id=?").get(id);
    if(saved===null||saved.claimed||saved.choice.ownerUserId!==choice.ownerUserId||saved.choice.channelId!==choice.channelId||saved.choice.targetThreadId!==choice.targetThreadId||saved.choice.prompt!==choice.prompt||saved.choice.allowSteer!==choice.allowSteer||saved.choice.createdAt!==choice.createdAt||saved.choice.expiresAt!==choice.createdAt+choice.expiresAt||route?.require_current_mirror!==Number(expected)||route.allow_steer!==Number(choice.allowSteer))throw new TypeError("Original busy choice insertion was not preserved");
}

export interface BusyChoiceState {readonly choice:BusyChoice;readonly claimed:boolean}
function readBusyChoiceRow(db:DatabaseSync,id:string):BusyChoiceState|null{
  const query=db.prepare(`SELECT owner_user_id,channel_id,target_thread_id,prompt,allow_steer,created_at,expires_at,claimed_at,
    CAST(target_thread_id AS BLOB) AS raw_target,CAST(prompt AS BLOB) AS raw_prompt,(SELECT encoding FROM pragma_encoding) AS encoding FROM busy_choices WHERE choice_id=?`);query.setReadBigInts(true);
  const row=query.get(id);if(row===undefined)return null;
  const decoder=textDecoderFor(row.encoding),ownerUserId=decodeI64(row.owner_user_id,"owner_user_id"),channelId=decodeI64(row.channel_id,"channel_id"),
    targetThreadId=decodeTextField(row.target_thread_id,row.raw_target,"target_thread_id",true,decoder),prompt=decodeTextField(row.prompt,row.raw_prompt,"prompt",false,decoder)!,
    allowSteer=decodeI64(row.allow_steer,"allow_steer")!==0n,createdAt=decodeTimestamp(row.created_at,"created_at"),expiresAt=decodeTimestamp(row.expires_at,"expires_at"),
    claimedAt=row.claimed_at===null?null:decodeTimestamp(row.claimed_at,"claimed_at");
  return {choice:{choiceId:id,ownerUserId,channelId,targetThreadId,prompt,allowSteer,createdAt,expiresAt},claimed:claimedAt!==null};
}
export async function getBusyChoice(path:string,id:string,now:number):Promise<BusyChoice|null>{
  text(id);timestamp(now);
  return withPromptIntakeWriter<BusyChoice|null>(path,db=>{
    const row=readBusyChoiceRow(db,id);if(row===null)return {value:null,commit:true};
    if(row.choice.expiresAt<=now){db.prepare("DELETE FROM busy_choices WHERE choice_id=?").run(id);return {value:null,commit:true};}
    return {value:row.claimed?null:row.choice,commit:true};
  },false);
}
/** Source runtime busy-state read: decode before expiry filter, retain claimed
 * state, and never delete expired rows as getBusyChoice intentionally does. */
export function readBusyChoiceState(path:string,id:string,now:number):Promise<BusyChoiceState|null>{
  text(id);timestamp(now);return owned(path,db=>readStateIn(db,id,now));
}
async function owned<T>(path:string,work:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return work(db);}finally{db.close();}}
function readStateIn(db:DatabaseSync,id:string,now:number):BusyChoiceState|null{const row=readBusyChoiceRow(db,id);return row===null||row.choice.expiresAt<=now?null:row;}
function checkedExisting<T>(path:string,work:(db:DatabaseSync)=>T):T{return usingExistingStore(path,db=>{withStoreTransaction(db,"DEFERRED",()=>{verifyCurrentCatalogIn(db);return rollbackStore(undefined);});return work(db);});}
/** Existing-only source read; decode before expiry, no cleanup or claim. */
export function readBusyChoiceStateExisting(path:string,id:string,now:number):BusyChoiceState|null{text(id);timestamp(now);return checkedExisting(path,db=>readStateIn(db,id,now));}
function claimIn(db:DatabaseSync,id:string,now:number):boolean{return BigInt(db.prepare("UPDATE busy_choices SET claimed_at=? WHERE choice_id=? AND claimed_at IS NULL AND expires_at>?").run(now,id,now).changes)===1n;}
export async function claimBusyChoice(path:string,id:string,now:number):Promise<boolean>{
  text(id);timestamp(now);return owned(path,db=>claimIn(db,id,now));
}
/** Preserve the separate source single-statement autocommit claim. */
export function claimBusyChoiceExisting(path:string,id:string,now:number):boolean{text(id);timestamp(now);return checkedExisting(path,db=>claimIn(db,id,now));}
function releaseIn(db:DatabaseSync,id:string):boolean{return BigInt(db.prepare("UPDATE busy_choices SET claimed_at=NULL WHERE choice_id=? AND claimed_at IS NOT NULL").run(id).changes)===1n;}
export async function releaseBusyChoiceClaim(path:string,id:string):Promise<boolean>{
  text(id);return owned(path,db=>releaseIn(db,id));
}
/** Preserve the separate source single-statement autocommit release. */
export function releaseBusyChoiceClaimExisting(path:string,id:string):boolean{text(id);return checkedExisting(path,db=>releaseIn(db,id));}
export async function cleanupBusyChoices(path:string,now:number):Promise<bigint>{timestamp(now);return owned(path,db=>BigInt(db.prepare("DELETE FROM busy_choices WHERE expires_at<=?").run(now).changes));}
export async function busyChoiceCounts(path:string,now:number):Promise<readonly [bigint,bigint]>{
  timestamp(now);return owned(path,db=>{
    const count=(where:string)=>{const s=db.prepare(`SELECT COUNT(*) AS n FROM busy_choices WHERE ${where}`);s.setReadBigInts(true);return decodeI64(s.get(now)?.n,"count");};
    return [count("expires_at>? AND claimed_at IS NULL"),count("expires_at<=? OR claimed_at IS NOT NULL")];
  });
}
