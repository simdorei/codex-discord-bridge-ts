import type {DatabaseSync} from "node:sqlite";
import {types} from "node:util";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
export interface BusyChoice {choiceId:string;ownerUserId:bigint;channelId:bigint;targetThreadId:string|null;prompt:string;allowSteer:boolean;createdAt:number;expiresAt:number}
export class BusyChoiceUnavailableError extends Error{
  readonly kind="BusyChoiceUnavailable";readonly choiceId:string;
  constructor(id:string){super(`busy choice is expired, changed, or already claimed: ${id}`);this.name="BusyChoiceUnavailableError";this.choiceId=id;}
}
export function busyChoiceDataField(input:unknown,key:string):unknown{
  if(input===null||typeof input!=="object"||types.isProxy(input)||Array.isArray(input))throw new TypeError("Expected busy choice data");
  const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own busy choice field");return d.value;
}
export function snapshotBusyChoice(input:BusyChoice):BusyChoice{
  const value=(key:string)=>busyChoiceDataField(input,key);
  const text=(v:unknown):string=>{if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed text");return v;};
  const integer=(v:unknown):bigint=>{if(typeof v!=="bigint"||v<-(1n<<63n)||v>=(1n<<63n))throw new TypeError("Expected i64 identity");return v;};
  const target=value("targetThreadId"),allow=value("allowSteer"),created=value("createdAt"),expires=value("expiresAt");
  if(typeof allow!=="boolean"||typeof created!=="number"||typeof expires!=="number")throw new TypeError("Expected busy choice flags/timestamps");
  return {choiceId:text(value("choiceId")),ownerUserId:integer(value("ownerUserId")),channelId:integer(value("channelId")),targetThreadId:target===null?null:text(target),prompt:text(value("prompt")),allowSteer:allow,createdAt:created,expiresAt:expires};
}
/** Source Serialize struct field order, with Serde's nonfinite f64 -> null convention. */
export function serializeBusyChoice(choice:BusyChoice):string{
  const c=snapshotBusyChoice(choice),s=serializeSerdeValue,f=(n:number)=>Number.isFinite(n)?s(n):"null";
  return `{"choice_id":${s(c.choiceId)},"owner_user_id":${s(c.ownerUserId)},"channel_id":${s(c.channelId)},"target_thread_id":${s(c.targetThreadId)},"prompt":${s(c.prompt)},"allow_steer":${s(c.allowSteer)},"created_at":${f(c.createdAt)},"expires_at":${f(c.expiresAt)}}`;
}
/** Mapping read contract differs from queue's exact mirror assertion: duplicate exact rooms are an integrity error. */
export function mirroredThreadIdIn(db:DatabaseSync,channel:bigint|null):string|null{
  if(channel===null||channel===0n)return null;
  const count=db.prepare("SELECT COUNT(*) AS n FROM mirror_threads WHERE discord_thread_id=?");count.setReadBigInts(true);
  if(decodeI64(count.get(channel)?.n,"mirror count")>1n)throw new StoreIntegrityError(`Discord room ${channel} is mapped to multiple Codex threads; routing refused`);
  const query=(where:string)=>db.prepare(`SELECT codex_thread_id,CAST(codex_thread_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM mirror_threads ${where}`);
  const decode=(row:Record<string,unknown>)=>decodeTextField(row.codex_thread_id,row.raw,"codex_thread_id",false,textDecoderFor(row.encoding))!;
  const exact=query("WHERE discord_thread_id=?").get(channel);if(exact!==undefined)return decode(exact);
  const rows:string[]=[];for(const row of query("WHERE discord_channel_id=? ORDER BY updated_at DESC LIMIT 2").iterate(channel))rows.push(decode(row));
  return rows.length===1?rows[0]!:null;
}
export function verifyBusyChoiceRouteIn(db:DatabaseSync,channel:bigint,target:string|null,mapped:boolean):void{
  const current=mirroredThreadIdIn(db,channel);
  if((mapped&&(target===null||current!==target))||(!mapped&&current!==null))throw new StoreIntegrityError("original busy prompt route changed; no request accepted");
}
