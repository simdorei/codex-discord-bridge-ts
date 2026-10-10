import {DatabaseSync,type SQLInputValue} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {StoreIntegrityError,schemaVersion,LATEST_STORE_SCHEMA_VERSION} from "./schema-assembly.ts";
import {decodeI64,decodeOptionalI64,decodeTimestamp,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
export type IngressKind="message"|"interaction"|"action";
export interface StoredIngress {
  ingressId:string;kind:IngressKind;eventId:bigint|null;applicationId:bigint|null;channelId:bigint;ownerUserId:bigint;
  sourceMessageId:bigint|null;payload:unknown;runtimeId:string|null;state:string;phase:string;targetThreadId:string|null;
  canonicalOwner:string|null;ownerKind:string|null;ownerId:string|null;outcome:unknown|undefined;confirmationDelivered:boolean;
  holdReason:string;createdAt:number;updatedAt:number;
}
const COLS="ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,canonical_owner,owner_kind,owner_id,outcome_json,confirmation_delivered,hold_reason,created_at,updated_at";
const TEXT=["ingress_id","kind","payload_json","runtime_id","state","phase","target_thread_id","canonical_owner","owner_kind","owner_id","outcome_json","hold_reason"];
const SELECT=`SELECT ${COLS},${TEXT.map(c=>`CAST(${c} AS BLOB) AS b_${c}`).join(",")},(SELECT encoding FROM pragma_encoding) AS encoding FROM discord_ingress_journal`;
function decode(row:Record<string,unknown>):StoredIngress{
  const decoder=textDecoderFor(row.encoding),text=(key:string,optional=false)=>decodeTextField(row[key],row["b_"+key],key,optional,decoder);
  const kind=text("kind");if(kind!=="message"&&kind!=="interaction"&&kind!=="action")throw new StoreIntegrityError("Invalid ingress kind");
  // Source reads the optional raw outcome before other fields, then parses it after payload.
  const rawOutcome=text("outcome_json",true),ingressId=text("ingress_id")!,eventId=decodeOptionalI64(row.event_id,"event_id"),
    applicationId=decodeOptionalI64(row.application_id,"application_id"),channelId=decodeI64(row.channel_id,"channel_id"),ownerUserId=decodeI64(row.owner_user_id,"owner_user_id"),
    sourceMessageId=decodeOptionalI64(row.source_message_id,"source_message_id"),payload:unknown=parseSerdeValue(text("payload_json")!),runtimeId=text("runtime_id",true),
    state=text("state")!,phase=text("phase")!,targetThreadId=text("target_thread_id",true),canonicalOwner=text("canonical_owner",true),
    ownerKind=text("owner_kind",true),ownerId=text("owner_id",true),outcome=rawOutcome===null?undefined:parseSerdeValue(rawOutcome),
    confirmationDelivered=decodeI64(row.confirmation_delivered,"confirmation_delivered")!==0n,holdReason=text("hold_reason")!,
    createdAt=decodeTimestamp(row.created_at,"created_at"),updatedAt=decodeTimestamp(row.updated_at,"updated_at");
  return {ingressId,kind,eventId,applicationId,channelId,ownerUserId,sourceMessageId,payload,runtimeId,state,phase,targetThreadId,canonicalOwner,ownerKind,ownerId,outcome,confirmationDelivered,holdReason,createdAt,updatedAt};
}
function rows(db:DatabaseSync,where:string,...args:SQLInputValue[]):StoredIngress[]{
  const query=db.prepare(SELECT+where);query.setReadBigInts(true);const result:StoredIngress[]=[];for(const row of query.iterate(...args))result.push(decode(row));return result;
}
export function getIngressIn(db:DatabaseSync,key:string):StoredIngress|null{
  const query=db.prepare(SELECT+" WHERE ingress_id=?");query.setReadBigInts(true);const row=query.get(key);return row===undefined?null:decode(row);
}
export function ingressByOriginIn(db:DatabaseSync,eventId:bigint):StoredIngress|null{
  const result=rows(db," WHERE event_id=? LIMIT 2",eventId);if(result.length>1)throw new StoreIntegrityError("ambiguous ingress origin identity");return result[0]??null;
}
/** Original event lookup; duplicate origins are integrity errors, never replay authority. */
export async function ingressByOrigin(path:string,eventId:bigint):Promise<StoredIngress|null>{
  if(typeof path!=="string"||/[\uD800-\uDFFF]/u.test(path))throw new TypeError("Expected well-formed path");
  if(typeof eventId!=="bigint"||eventId<-(1n<<63n)||eventId>=(1n<<63n))throw new TypeError("Expected i64 origin");
  const db=await openInitialized(path);try{return ingressByOriginIn(db,eventId);}finally{db.close();}
}
export async function getIngress(path:string,key:string):Promise<StoredIngress|null>{
  const db=await openInitialized(path);try{return getIngressIn(db,key);}finally{db.close();}
}

export class ReadOnlySchemaVersionError extends Error{
  readonly kind="ReadOnlySchemaVersion";readonly found:bigint;readonly expected:bigint;
  constructor(found:bigint,expected:bigint){super(`read-only store inspection requires schema version ${expected}; found ${found}; no migration performed`);this.name="ReadOnlySchemaVersionError";this.found=found;this.expected=expected;}
}
function ownerScope(path:string,channel:bigint,owner:bigint,key?:string):void{
  for(const v of key===undefined?[path]:[path,key])if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed text");
  for(const v of [channel,owner])if(typeof v!=="bigint"||v<-(1n<<63n)||v>=(1n<<63n))throw new TypeError("Expected i64 identity");
}
/** Filter actor/room before decoding; never initialize or inspect another actor's payload. */
export function getIngressForOwnerReadonly(path:string,key:string,channel:bigint,owner:bigint):StoredIngress|null{
  ownerScope(path,channel,owner,key);const db=new DatabaseSync(path,{readOnly:true});try{db.exec("PRAGMA busy_timeout=250");const found=schemaVersion(db);
    if(found!==LATEST_STORE_SCHEMA_VERSION)throw new ReadOnlySchemaVersionError(found,LATEST_STORE_SCHEMA_VERSION);
    return rows(db," WHERE ingress_id=? AND channel_id=? AND owner_user_id=?",key,channel,owner)[0]??null;
  }finally{db.close();}
}
export function unfinishedPriorIngressesIn(db:DatabaseSync,runtime:string):StoredIngress[]{
  return rows(db," WHERE runtime_id IS NOT ? AND owner_id IS NULL AND state IN ('staged','acknowledged','executing','completed') AND confirmation_delivered=0 ORDER BY created_at,ingress_id",runtime);
}
export async function listIngressesForOwner(path:string,channel:bigint,owner:bigint):Promise<StoredIngress[]>{
  ownerScope(path,channel,owner);const db=await openInitialized(path);try{return rows(db," WHERE channel_id=? AND owner_user_id=? AND (state='held' OR (state='completed' AND confirmation_delivered=0)) ORDER BY created_at DESC,ingress_id LIMIT 20",channel,owner);}finally{db.close();}
}
