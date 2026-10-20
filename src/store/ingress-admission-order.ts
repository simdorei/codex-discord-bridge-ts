import {createHash} from "node:crypto";
import type {DatabaseSync,SQLInputValue} from "node:sqlite";
import type {NewIngress} from "./ingress-types.ts";
import {AdmissionOrderIntegrityError} from "./schema-admission-order.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeI64,decodeOptionalI64,decodeTimestamp,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
const FIELDS=["version","kind","event_id","application_id","channel_id","owner_user_id","source_message_id","payload_json","runtime_id","target_thread_id","canonical_owner","created_at_bits"] as const;
type Identity=Readonly<Record<typeof FIELDS[number],string|bigint|null>>;
const brand:unique symbol=Symbol("original admission");
/** Opaque original evidence; never execution/release permission. Not a serializable receipt. */
export interface RecordedAdmission {readonly [brand]:true}
interface Proof {id:string;identity:Identity;sequence:bigint;digest:string}
const proofs=new WeakMap<RecordedAdmission,Proof>();
function invalid(reason:string):never{throw new AdmissionOrderIntegrityError(reason);}
function requireTransaction(db:DatabaseSync):void{if(!db.isTransaction)throw new StoreIntegrityError("Borrowed mutation requires an active transaction");}
function row(db:DatabaseSync,sql:string,...values:SQLInputValue[]):Record<string,unknown>|undefined{const q=db.prepare(sql);q.setReadBigInts(true);return q.get(...values);}
function requireCurrent(db:DatabaseSync):void{
  const found=row(db,"SELECT format_version FROM cdr_runtime_capability_requirements WHERE component=?","recovery_admission_order");
  if(decodeI64(found?.format_version,"format_version")!==1n)invalid("unsupported current admission order format");
}
function bits(value:number):bigint{const b=Buffer.alloc(8);b.writeDoubleLE(value);return b.readBigUInt64LE();}
const TEXT=["kind","payload_json","runtime_id","target_thread_id","canonical_owner"] as const;
function identityIn(db:DatabaseSync,id:string):Identity{
  const found=row(db,`SELECT version,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,target_thread_id,canonical_owner,created_at,
    ${TEXT.map(k=>`CAST(${k} AS BLOB) AS b_${k}`).join(",")},(SELECT encoding FROM pragma_encoding) AS encoding FROM discord_ingress_journal WHERE ingress_id=?`,id);
  if(found===undefined)invalid("original ingress is missing");
  const decoder=textDecoderFor(found.encoding),text=(k:typeof TEXT[number],optional=false)=>decodeTextField(found[k],found["b_"+k],k,optional,decoder);
  return {version:decodeI64(found.version,"version"),kind:text("kind")!,event_id:decodeOptionalI64(found.event_id,"event_id"),application_id:decodeOptionalI64(found.application_id,"application_id"),
    channel_id:decodeI64(found.channel_id,"channel_id"),owner_user_id:decodeI64(found.owner_user_id,"owner_user_id"),source_message_id:decodeOptionalI64(found.source_message_id,"source_message_id"),
    payload_json:text("payload_json")!,runtime_id:text("runtime_id",true),target_thread_id:text("target_thread_id",true),canonical_owner:text("canonical_owner",true),created_at_bits:bits(decodeTimestamp(found.created_at,"created_at"))};
}
function same(a:Identity,b:Identity):boolean{return FIELDS.every(k=>a[k]===b[k]);}
function identityBytes(value:Identity):string{return "{"+FIELDS.map(k=>JSON.stringify(k)+":"+serializeSerdeValue(value[k])).join(",")+"}";}
const MATCH="ingress_id=?2 AND kind=?3 AND event_id IS ?4 AND origin='admitted' AND identity_sha256=?5";
export function verifyRecordedAdmissionIn(db:DatabaseSync,recorded:RecordedAdmission):void{
  requireTransaction(db);const proof=proofs.get(recorded);if(!proof)invalid("original admission proof is missing");requireCurrent(db);
  const retained=row(db,`SELECT EXISTS(SELECT 1 FROM cdr_recovery_ingress_order WHERE sequence=?1 AND ${MATCH}) AS held`,proof.sequence,proof.id,proof.identity.kind,proof.identity.event_id,proof.digest);
  if(decodeI64(retained?.held,"held")===0n||!same(identityIn(db,proof.id),proof.identity))invalid("admission identity changed after ordinal INSERT");
}
/** After the original journal INSERT, in its IMMEDIATE transaction. Never call on a duplicate/legacy branch. */
export function recordNewAdmissionIn(db:DatabaseSync,request:NewIngress,runtime:string|null):RecordedAdmission{
  requireTransaction(db);requireCurrent(db);
  const id=request.ingressId,expected:Identity={version:1n,kind:request.kind,event_id:request.eventId,application_id:request.applicationId,
    channel_id:request.channelId,owner_user_id:request.ownerUserId,source_message_id:request.sourceMessageId,payload_json:serializeSerdeValue(request.payload),runtime_id:runtime,
    target_thread_id:request.targetThreadId,canonical_owner:request.canonicalOwner,created_at_bits:bits(request.now===0?0:request.now)};
  if(!same(identityIn(db,id),expected))invalid("original persisted ingress differs from admission");
  const previous=decodeI64(row(db,"SELECT COALESCE(MAX(sequence),0) AS value FROM cdr_recovery_ingress_order")?.value,"sequence");
  if(previous===(1n<<63n)-1n)invalid("durable sequence exhausted");
  const digest=createHash("sha256").update(identityBytes(expected)).digest("hex");
  const written=db.prepare("INSERT INTO cdr_recovery_ingress_order (ingress_id,kind,event_id,origin,identity_sha256) VALUES(?,?,?,'admitted',?)").run(id,expected.kind,expected.event_id,digest);
  if(BigInt(written.changes)!==1n)invalid("ordinal INSERT did not retain the original admission");
  const sequence=decodeI64(row(db,`SELECT sequence FROM cdr_recovery_ingress_order WHERE sequence>?1 AND ${MATCH}`,previous,id,expected.kind,expected.event_id,digest)?.sequence,"sequence");
  const proof=Object.freeze({[brand]:true as const});proofs.set(proof,{id,identity:expected,sequence,digest});verifyRecordedAdmissionIn(db,proof);return proof;
}
