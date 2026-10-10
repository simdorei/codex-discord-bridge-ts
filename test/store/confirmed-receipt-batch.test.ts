import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {requireConfirmedReceiptBatchIn as check,UnconfirmedReceiptBatchError} from "../../src/store/confirmed-receipt-batch.ts";
const hash="a".repeat(64),expected=[{key:"key",contentHash:hash}];
function run(fn:(db:DatabaseSync)=>void,encoding="UTF-8"){
  const db=new DatabaseSync(":memory:");
  try{db.exec(`PRAGMA encoding='${encoding}'; CREATE TABLE codex_delivery_receipts(receipt_key TEXT COLLATE NOCASE,content_hash,message_id,retryable,blocked_reason); BEGIN`);fn(db);}
  finally{db.close();}
}
function put(db:DatabaseSync,message:unknown="123",key="key",digest=hash){
  db.prepare("INSERT INTO codex_delivery_receipts VALUES (?,?,?,1,'stale flag')").run(key,digest,message as string);
}
test("confirmed exact batch preserves transaction and ignores stale retry flags",()=>run(db=>{
  put(db);check(db,expected);check(db,[...expected,...expected]);assert.equal(db.isTransaction,true);
  assert.equal(db.prepare("SELECT count(*) AS n FROM codex_delivery_receipts").get()!.n,1);
  db.exec("ROLLBACK");assert.equal(db.prepare("SELECT count(*) AS n FROM codex_delivery_receipts").get()!.n,0);
}));
test("missing, unknown and content-conflicting receipts never authorize",()=>{
  run(db=>assert.throws(()=>check(db,expected),UnconfirmedReceiptBatchError));
  run(db=>{put(db,null);assert.throws(()=>check(db,expected),UnconfirmedReceiptBatchError)});
  run(db=>{put(db,"123","key","b".repeat(64));assert.throws(()=>check(db,expected),UnconfirmedReceiptBatchError)});
});
test("legacy duplicate exact key is refused while NOCASE lookalike cannot substitute",()=>{
  run(db=>{put(db);put(db);assert.throws(()=>check(db,expected),UnconfirmedReceiptBatchError)});
  run(db=>{put(db,"123","KEY");assert.throws(()=>check(db,expected),UnconfirmedReceiptBatchError)});
});
test("message IDs require canonical positive lossless u64",()=>{
  for(const m of ["0","01","-1","1.0","1\n","1\r\n","18446744073709551616","1\0suffix","1"+"x".repeat(100000),Buffer.from("123"),null]){
    run(db=>{put(db,m);assert.throws(()=>check(db,expected),UnconfirmedReceiptBatchError)});
  }
  run(db=>{put(db,"18446744073709551615");check(db,expected)});
});
test("UTF16 databases accept complete 20 digit IDs without a false byte cap",()=>{
  for(const encoding of ["UTF-16le","UTF-16be"])run(db=>{put(db,"18446744073709551615");check(db,expected)},encoding);
});
test("invalid UTF8 text cannot pass the strict receipt decoder",()=>run(db=>{
  db.prepare("INSERT INTO codex_delivery_receipts VALUES (?, ?, CAST(X'FF' AS TEXT),0,NULL)").run("key",hash);
  assert.throws(()=>check(db,expected));
}));
test("requires caller transaction and does not create one for empty input",()=>run(db=>{
  db.exec("COMMIT");assert.throws(()=>check(db,[]),/active transaction/);assert.equal(db.isTransaction,false);
  db.exec("BEGIN");check(db,[]);assert.equal(db.isTransaction,true);
}));
test("bounds and own-data validation execute without getters or proxy traps",()=>run(db=>{
  let calls=0;const bad={get key(){calls++;return "key"},contentHash:hash};
  assert.throws(()=>check(db,[bad]),TypeError);
  assert.throws(()=>check(db,new Proxy(expected,{get(){calls++;throw Error("trap")}})),TypeError);
  assert.throws(()=>check(db,new Array(4097)),RangeError);
  assert.throws(()=>check(db,[{key:"x".repeat(65537),contentHash:hash}]),RangeError);
  assert.throws(()=>check(db,Array.from({length:17},()=>({key:"x".repeat(65536),contentHash:hash}))),RangeError);
  assert.throws(()=>check(db,[{key:"\uD800",contentHash:hash}]),TypeError);
  assert.equal(calls,0);
}));
test("native missing-schema failure propagates and query-only reads remain valid",()=>run(db=>{
  put(db);db.exec("PRAGMA query_only=ON");check(db,expected);db.exec("PRAGMA query_only=OFF; DROP TABLE codex_delivery_receipts");
  assert.throws(()=>check(db,expected),/no such table/);assert.equal(db.isTransaction,true);
}));
