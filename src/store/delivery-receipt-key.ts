import type {DatabaseSync,SQLInputValue} from "node:sqlite";
import {createHash} from "node:crypto";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
export interface DeliveryGuard {readonly jobId:string;readonly threadId:string;readonly turnId:string}
export type ReceiptKey=readonly [channel:bigint,domain:string,logical:string,index:bigint];
/** Exact serde (i64,String,String,usize) key profile on the pinned 64-bit target. */
export function parseReceiptKey(raw:string):ReceiptKey|null{
  let value:unknown;try{value=parseSerdeValue(raw);}catch{return null;}
  if(!Array.isArray(value)||value.length!==4)return null;const [channel,domain,logical,index]=value;
  if(typeof channel!=="bigint"||channel<-(1n<<63n)||channel>=(1n<<63n)||typeof domain!=="string"||typeof logical!=="string"||typeof index!=="bigint"||index<0n||index>=(1n<<64n))return null;
  return [channel,domain,logical,index];
}
export function receiptHash(content:string):string{return createHash("sha256").update(content).digest("hex");}
export function receiptRow(db:DatabaseSync,sql:string,...args:SQLInputValue[]):Record<string,unknown>|undefined{const q=db.prepare(sql);q.setReadBigInts(true);return q.get(...args);}
export function receiptExists(db:DatabaseSync,sql:string,...args:SQLInputValue[]):boolean{return decodeI64(receiptRow(db,sql,...args)?.held,"held")!==0n;}
export function receiptText(row:Record<string,unknown>,key:string,optional=false):string|null{return decodeTextField(row[key],row["raw_"+key],key,optional,textDecoderFor(row.encoding));}
export const receiptTextColumns=(...keys:string[]):string=>keys.map(k=>`CAST(${k} AS BLOB) AS raw_${k}`).join(",")+",(SELECT encoding FROM pragma_encoding) AS encoding";
