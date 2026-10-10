import {types} from "node:util";
import type {DatabaseSync} from "node:sqlite";
import {receiptText} from "./delivery-receipt-key.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";

export interface ExpectedReceipt {readonly key:string;readonly contentHash:string}
export class UnconfirmedReceiptBatchError extends Error {
  readonly index:number;
  constructor(index:number){super("Receipt batch is not fully confirmed");this.name="UnconfirmedReceiptBatchError";this.index=index;}
}
function own(object:object,key:string):unknown{
  const d=Object.getOwnPropertyDescriptor(object,key);
  if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own receipt data");
  return d.value;
}
function snapshot(input:readonly ExpectedReceipt[]):readonly ExpectedReceipt[]{
  if(typeof input!=="object"||input===null||types.isProxy(input)||!Array.isArray(input))throw new TypeError("Expected receipt array");
  if(input.length>4096)throw new RangeError("Receipt count exceeds 4096");
  const result:ExpectedReceipt[]=[];let bytes=0;
  for(let i=0;i<input.length;i++){
    const row=own(input,String(i));
    if(typeof row!=="object"||row===null||types.isProxy(row))throw new TypeError("Expected receipt data");
    const key=own(row,"key"),contentHash=own(row,"contentHash");
    if(typeof key!=="string"||/[\uD800-\uDFFF]/u.test(key)||typeof contentHash!=="string"||contentHash.length!==64||!/^[0-9a-f]{64}$/.test(contentHash))throw new TypeError("Invalid expected receipt");
    if(key.length>65536)throw new RangeError("Receipt key budget exceeded");
    const length=Buffer.byteLength(key);bytes+=length+64;
    if(length>65536||bytes>1048576)throw new RangeError("Receipt key budget exceeded");
    result.push(Object.freeze({key,contentHash}));
  }
  return Object.freeze(result);
}
/**
 * Read-only guard inside the caller's existing transaction. This proves only
 * the supplied exact receipt keys and hashes have confirmed message IDs.
 * It does not establish mirror-item coverage, cursor ownership or a file generation.
 * Runtime integration must execute this synchronous leaf in an owned DB worker.
 */
export function requireConfirmedReceiptBatchIn(db:DatabaseSync,input:readonly ExpectedReceipt[]):void{
  const expected=snapshot(input);
  if(!db.isTransaction)throw new StoreIntegrityError("confirmed receipt batch requires an active transaction");
  if(expected.length===0)return;
  const sql=`SELECT hash_matches,mid,CAST(mid AS BLOB) AS raw_mid,
    (SELECT encoding FROM pragma_encoding) AS encoding FROM (
      SELECT typeof(content_hash)='text' AND CAST(content_hash AS BLOB)=CAST(? AS BLOB) AS hash_matches,
      CASE WHEN typeof(message_id)='text' AND length(CAST(message_id AS BLOB)) BETWEEN 1 AND 80
        AND length(message_id) BETWEEN 1 AND 20 THEN message_id END AS mid
      FROM codex_delivery_receipts
      WHERE receipt_key=? AND CAST(receipt_key AS BLOB)=CAST(? AS BLOB) LIMIT 2
    )`;
  const statement=db.prepare(sql);statement.setReadBigInts(true);
  for(let i=0;i<expected.length;i++){
    const e=expected[i]!,rows=statement.all(e.contentHash,e.key,e.key);
    if(rows.length!==1||rows[0]!.hash_matches!==1n)throw new UnconfirmedReceiptBatchError(i);
    const message=receiptText(rows[0]!,"mid",true);
    if(message===null||!(/^[1-9][0-9]{0,19}$/.test(message))||BigInt(message)>18446744073709551615n)throw new UnconfirmedReceiptBatchError(i);
  }
}
