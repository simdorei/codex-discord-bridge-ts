import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {snapshotNewIngress,type NewIngress} from "./ingress-types.ts";
import {getOwn,pointer,isJsonObject} from "./async-resolution-json-helpers.ts";
import {newThreadOriginIn} from "./new-thread-origin.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import {trimUnicodeWhitespace as trim} from "./queue-preflight-failure.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
const PENDING="FROM discord_ingress_journal WHERE channel_id=? AND owner_user_id=? AND kind='message' AND json_type(payload_json,'$.new_prompt_arm')='object' ORDER BY event_id DESC LIMIT 1";
export async function pendingNewPrompt(path:string,channel:bigint,user:bigint,event:bigint):Promise<string|null>{
  for(const value of [channel,user,event])if(typeof value!=="bigint"||value<-(1n<<63n)||value>=(1n<<63n))throw new TypeError("Expected i64 identity");
  const db=await openInitialized(path);try{
    const q=db.prepare(`SELECT ingress_id,CAST(ingress_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding,event_id < ? AND json_extract(payload_json,'$.new_prompt_arm.consumed_by') IS NULL AS pending ${PENDING}`);q.setReadBigInts(true);const r=q.get(event,channel,user);
    if(r===undefined)return null;const id=decodeTextField(r.ingress_id,r.raw,"ingress_id",false,textDecoderFor(r.encoding))!;return decodeI64(r.pending,"pending")!==0n?id:null;
  }finally{db.close();}
}
/** Access checks remain the caller's responsibility. Consumption shares the admission writer transaction. */
export function prepareNewPromptArmIn(db:DatabaseSync,original:NewIngress):NewIngress{
  if(!db.isTransaction)throw new StoreIntegrityError("Borrowed mutation requires an active transaction");
  const request=snapshotNewIngress(original),p=request.payload;
  if(request.kind!=="message"||!isJsonObject(p)||getOwn(p,"version")!==1n||getOwn(p,"author_is_bot")!==false)return request;
  const content=getOwn(p,"content"),raw=typeof content==="string"?trim(content):"";
  if(pointer(p,"/plan/Execute/New/prompt")===""&&/^!new$/i.test(raw)){
    p.new_prompt_arm={consumed_by:null};p.plan={Respond:"새 대화를 준비했습니다. 같은 방에 첫 요청을 보내주세요."};request.targetThreadId=null;return request;
  }
  if(raw.startsWith("!")||pointer(p,"/plan/Execute/Ask/prompt")===undefined)return request;
  const withoutConsumption=():NewIngress=>{if(typeof getOwn(p,"new_prompt_mention_arm")==="string"){
    request.targetThreadId=null;p.plan={Respond:"ERROR: !new 예약이 이미 사용되었거나 변경되어 이 글은 실행하지 않았습니다. !new를 다시 입력하거나 필요한 멘션을 포함해주세요."};}return request;};
  const q=db.prepare(`SELECT ingress_id,event_id,payload_json,CAST(ingress_id AS BLOB) AS id_raw,CAST(payload_json AS BLOB) AS payload_raw,(SELECT encoding FROM pragma_encoding) AS encoding ${PENDING}`);q.setReadBigInts(true);const r=q.get(request.channelId,request.ownerUserId);
  if(r===undefined)return withoutConsumption();const decoder=textDecoderFor(r.encoding),id=decodeTextField(r.ingress_id,r.id_raw,"ingress_id",false,decoder)!,event=decodeI64(r.event_id,"event_id"),arm=parseSerdeValue(decodeTextField(r.payload_json,r.payload_raw,"payload_json",false,decoder)!);
  const mention=getOwn(p,"new_prompt_mention_arm");
  if(request.eventId===null||request.eventId<=event||(pointer(arm,"/new_prompt_arm/consumed_by")??null)!==null||(typeof mention==="string"&&mention!==id))return withoutConsumption();
  db.prepare("UPDATE discord_ingress_journal SET payload_json=json_set(payload_json,'$.new_prompt_arm.consumed_by',?),updated_at=? WHERE ingress_id=?").run(request.ingressId,request.now,id);
  p.new_prompt_arm_ref=id;request.targetThreadId=null;
  if(getOwn(p,"new_origin")===undefined)p.new_origin=newThreadOriginIn(db,request.channelId);
  if(serdeValueEqual(getOwn(arm,"routing")??null,getOwn(p,"routing")??null)&&serdeValueEqual(getOwn(arm,"new_origin")??null,getOwn(p,"new_origin")??null))p.plan={Execute:{New:{prompt:pointer(p,"/plan/Execute/Ask/prompt")}}};
  else p.plan={Respond:"ERROR: !new 이후 방 연결이 변경되었습니다. 실행하지 않았습니다. !new를 다시 입력해주세요."};
  return request;
}
