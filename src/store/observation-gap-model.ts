import type {DatabaseSync,SQLInputValue} from "node:sqlite";
import {parseSerdeStructArray} from "../core/serde-struct-json.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
export interface ObservationScope{readonly ownerId:string;readonly generation:bigint}
export interface ObservationSpan{readonly first:bigint;readonly last:bigint}
export interface ObservationGap{readonly id:bigint;readonly scope:ObservationScope;readonly first:bigint;readonly last:bigint;readonly cursor:bigint;readonly revision:bigint;readonly verified:readonly ObservationSpan[]}
export const OBSERVATION_PAGE_SIZE=32;
export const I64_MAX=(1n<<63n)-1n;
export function text(value:string):void{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed observation text");}
export function integer(value:bigint):void{if(typeof value!=="bigint"||value<-(1n<<63n)||value>I64_MAX)throw new TypeError("Expected i64 observation value");}
export function scope(value:ObservationScope):ObservationScope{const owned=cloneOwnedSerdeValue(value);if(owned===null||typeof owned!=="object"||Array.isArray(owned)||Object.keys(owned).length!==2||!Object.hasOwn(owned,"ownerId")||!Object.hasOwn(owned,"generation"))throw new TypeError("Expected exact observation scope");const s=owned as ObservationScope;text(s.ownerId);integer(s.generation);return s;}
export function requiredTransaction(db:DatabaseSync):void{if(!db.isTransaction)throw new StoreIntegrityError("Observation proof requires an active transaction");}
export function scalar(db:DatabaseSync,sql:string,...params:SQLInputValue[]):bigint{const statement=db.prepare(sql);statement.setReadBigInts(true);return decodeI64(statement.get(...params)?.n,"observation scalar");}
export function active(db:DatabaseSync,s:ObservationScope):boolean{return scalar(db,"SELECT EXISTS(SELECT 1 FROM cdr_observation_streams WHERE owner_id=?1 AND generation=?2 AND active=1) AS n",s.ownerId,s.generation)!==0n;}
export const GAP_COLUMNS="gap_id,owner_id,generation,first_seq,last_seq,scan_cursor,revision,state,verified_json,CAST(owner_id AS BLOB) AS owner_raw,CAST(verified_json AS BLOB) AS verified_raw,(SELECT encoding FROM pragma_encoding) AS encoding";
export function readGapRow(row:Record<string,unknown>):ObservationGap{
  const decoder=textDecoderFor(row.encoding),json=decodeTextField(row.verified_json,row.verified_raw,"verified_json",false,decoder)!;
  const verified=parseSerdeStructArray(json,{fields:[["first","i64"],["last","i64"]]}).map(s=>Object.freeze({first:s.first as bigint,last:s.last as bigint}));
  return Object.freeze({id:decodeI64(row.gap_id,"gap_id"),scope:Object.freeze({ownerId:decodeTextField(row.owner_id,row.owner_raw,"owner_id",false,decoder)!,generation:decodeI64(row.generation,"generation")}),first:decodeI64(row.first_seq,"first_seq"),last:decodeI64(row.last_seq,"last_seq"),cursor:decodeI64(row.scan_cursor,"scan_cursor"),revision:decodeI64(row.revision,"revision"),verified:Object.freeze(verified)});
}
export function readGap(db:DatabaseSync,id:bigint):ObservationGap|null{const statement=db.prepare(`SELECT ${GAP_COLUMNS} FROM cdr_observation_gaps WHERE gap_id=?`);statement.setReadBigInts(true);const row=statement.get(id);return row===undefined?null:readGapRow(row);}
export function gapComplete(g:ObservationGap):boolean{return g.verified.length===1&&g.verified[0]!.first===g.first&&g.verified[0]!.last===g.last;}
export function gapContains(g:ObservationGap,sequence:bigint):boolean{return g.verified.some(s=>s.first<=sequence&&sequence<=s.last);}
export function addVerifiedSequence(g:ObservationGap,sequence:bigint):ObservationGap{
  integer(sequence);if(sequence<g.first||sequence>g.last)throw new StoreIntegrityError("proof outside range");const spans=[...g.verified,{first:sequence,last:sequence}].sort((a,b)=>a.first<b.first?-1:a.first>b.first?1:0),merged:{first:bigint;last:bigint}[]=[];
  for(const s of spans){const prior=merged.at(-1);if(prior&&s.first<=(prior.last===I64_MAX?I64_MAX:prior.last+1n)){if(s.last>prior.last)prior.last=s.last;}else merged.push({...s});}if(merged.length>4096)throw new StoreIntegrityError("observation proof span budget exhausted");return Object.freeze({...g,verified:Object.freeze(merged.map(s=>Object.freeze(s)))});
}
export function gapEqual(a:ObservationGap,b:ObservationGap):boolean{return a.id===b.id&&a.scope.ownerId===b.scope.ownerId&&a.scope.generation===b.scope.generation&&a.first===b.first&&a.last===b.last&&a.cursor===b.cursor&&a.revision===b.revision&&a.verified.length===b.verified.length&&a.verified.every((s,i)=>s.first===b.verified[i]!.first&&s.last===b.verified[i]!.last);}
/** Internal proof writer only after effect checks in the same owned transaction. */
export function saveGap(db:DatabaseSync,expected:ObservationGap,next:ObservationGap):boolean{requiredTransaction(db);return BigInt(db.prepare(`UPDATE cdr_observation_gaps SET scan_cursor=?1,revision=revision+1,state=?2,verified_json=?3
 WHERE gap_id=?4 AND owner_id=?5 AND generation=?6 AND first_seq=?7 AND last_seq=?8 AND scan_cursor=?9 AND revision=?10`).run(next.cursor,gapComplete(next)?"Verified":"Open",serializeSerdeValue(next.verified),expected.id,expected.scope.ownerId,expected.scope.generation,expected.first,expected.last,expected.cursor,expected.revision).changes)===1n;}

/** Snapshot an internal typed Gap before asynchronous opening; not a durable proof. */
export function cloneObservationGap(value:ObservationGap):ObservationGap{
  const owned=cloneOwnedSerdeValue(value);const keys=["id","scope","first","last","cursor","revision","verified"];
  if(owned===null||typeof owned!=="object"||Array.isArray(owned)||Object.keys(owned).length!==keys.length||keys.some(k=>!Object.hasOwn(owned,k)))throw new TypeError("Expected exact observation gap");const g=owned as ObservationGap;
  scope(g.scope);for(const v of [g.id,g.first,g.last,g.cursor,g.revision])integer(v);if(!Array.isArray(g.verified))throw new TypeError("Expected observation span vector");
  for(const s of g.verified){if(s===null||typeof s!=="object"||Array.isArray(s)||Object.keys(s).length!==2||!Object.hasOwn(s,"first")||!Object.hasOwn(s,"last"))throw new TypeError("Expected exact observation span");integer(s.first);integer(s.last);}return g;
}
