import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {withPromptIntakeWriter} from "./prompt-intake.ts";
import {openInitialized} from "./owned-driver.ts";
import {snapshotBusyChoice,busyChoiceDataField,mirroredThreadIdIn,verifyBusyChoiceRouteIn,type BusyChoice} from "./busy-choice.ts";
import {decodeI64,decodeTimestamp,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
export interface NewBusyChoice {ownerUserId:bigint;channelId:bigint;targetThreadId:string|null;prompt:string;allowSteer:boolean;now:number;timeToLive:number}
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed text");}
function timestamp(value:unknown):asserts value is number{if(typeof value!=="number")throw new TypeError("Expected numeric timestamp");}
/** null route means infer the original mapping, not an unknown stored legacy route. */
export async function createBusyChoice(path:string,input:NewBusyChoice,expected:boolean|null=null):Promise<string>{
  // NewBusyChoice is snapshotted through the same stable choice validator.
  const value=(key:string)=>busyChoiceDataField(input,key);
  const choice=snapshotBusyChoice({choiceId:"",ownerUserId:value("ownerUserId"),channelId:value("channelId"),targetThreadId:value("targetThreadId"),
    prompt:value("prompt"),allowSteer:value("allowSteer"),createdAt:value("now"),expiresAt:value("timeToLive")} as BusyChoice);
  if(expected!==null&&typeof expected!=="boolean")throw new TypeError("Expected optional route mode");
  return withPromptIntakeWriter(path,db=>{
    const current=mirroredThreadIdIn(db,choice.channelId),mapped=expected??(current!==null);
    verifyBusyChoiceRouteIn(db,choice.channelId,choice.targetThreadId,mapped);
    db.prepare("DELETE FROM busy_choices WHERE expires_at<=?").run(choice.createdAt);
    const id=randomUUID().replaceAll("-","").slice(0,24);
    db.prepare(`INSERT INTO busy_choices(choice_id,owner_user_id,channel_id,target_thread_id,prompt,allow_steer,created_at,expires_at,claimed_at,require_current_mirror)
      VALUES (?,?,?,?,?,?,?,?,NULL,?)`).run(id,choice.ownerUserId,choice.channelId,choice.targetThreadId,choice.prompt,Number(choice.allowSteer),choice.createdAt,choice.createdAt+choice.expiresAt,Number(mapped));
    return {value:id,commit:true};
  },false);
}
export async function getBusyChoice(path:string,id:string,now:number):Promise<BusyChoice|null>{
  text(id);timestamp(now);
  return withPromptIntakeWriter<BusyChoice|null>(path,db=>{
    const query=db.prepare(`SELECT owner_user_id,channel_id,target_thread_id,prompt,allow_steer,created_at,expires_at,claimed_at,
      CAST(target_thread_id AS BLOB) AS raw_target,CAST(prompt AS BLOB) AS raw_prompt,(SELECT encoding FROM pragma_encoding) AS encoding FROM busy_choices WHERE choice_id=?`);query.setReadBigInts(true);
    const row=query.get(id);if(row===undefined)return {value:null,commit:true};
    const decoder=textDecoderFor(row.encoding),ownerUserId=decodeI64(row.owner_user_id,"owner_user_id"),channelId=decodeI64(row.channel_id,"channel_id"),
      targetThreadId=decodeTextField(row.target_thread_id,row.raw_target,"target_thread_id",true,decoder),prompt=decodeTextField(row.prompt,row.raw_prompt,"prompt",false,decoder)!,
      allowSteer=decodeI64(row.allow_steer,"allow_steer")!==0n,createdAt=decodeTimestamp(row.created_at,"created_at"),expiresAt=decodeTimestamp(row.expires_at,"expires_at"),
      claimedAt=row.claimed_at===null?null:decodeTimestamp(row.claimed_at,"claimed_at");
    if(expiresAt<=now){db.prepare("DELETE FROM busy_choices WHERE choice_id=?").run(id);return {value:null,commit:true};}
    return {value:claimedAt!==null?null:{choiceId:id,ownerUserId,channelId,targetThreadId,prompt,allowSteer,createdAt,expiresAt},commit:true};
  },false);
}
async function owned<T>(path:string,work:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return work(db);}finally{db.close();}}
export async function claimBusyChoice(path:string,id:string,now:number):Promise<boolean>{
  text(id);timestamp(now);return owned(path,db=>BigInt(db.prepare("UPDATE busy_choices SET claimed_at=? WHERE choice_id=? AND claimed_at IS NULL AND expires_at>?").run(now,id,now).changes)===1n);
}
export async function releaseBusyChoiceClaim(path:string,id:string):Promise<boolean>{
  text(id);return owned(path,db=>BigInt(db.prepare("UPDATE busy_choices SET claimed_at=NULL WHERE choice_id=? AND claimed_at IS NOT NULL").run(id).changes)===1n);
}
export async function cleanupBusyChoices(path:string,now:number):Promise<bigint>{timestamp(now);return owned(path,db=>BigInt(db.prepare("DELETE FROM busy_choices WHERE expires_at<=?").run(now).changes));}
export async function busyChoiceCounts(path:string,now:number):Promise<readonly [bigint,bigint]>{
  timestamp(now);return owned(path,db=>{
    const count=(where:string)=>{const s=db.prepare(`SELECT COUNT(*) AS n FROM busy_choices WHERE ${where}`);s.setReadBigInts(true);return decodeI64(s.get(now)?.n,"count");};
    return [count("expires_at>? AND claimed_at IS NULL"),count("expires_at<=? OR claimed_at IS NOT NULL")];
  });
}
