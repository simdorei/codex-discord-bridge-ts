import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { asyncClaimDigest, readAsyncObligationsIn } from "../../src/store/async-resolution-records.ts";
function fixture(run: (db: DatabaseSync) => void, encoding = "UTF-8"): void {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA encoding='${encoding}'; CREATE TABLE cdr_async_execution_obligations(
      question_id,thread_id,origin_job_id,turn_id,format_version,revision,answer_state,execution_state,
      admission_state,policy,original_seal,claim_json,owner_json,original_error);
      CREATE VIEW cdr_async_unsettled_obligations AS SELECT * FROM cdr_async_execution_obligations WHERE admission_state='held'`);
    run(db);
  } finally { db.close(); }
}
function insert(db: DatabaseSync, id = "q"): void {
  db.prepare("INSERT INTO cdr_async_execution_obligations VALUES (?, 'target','job','turn',1,7,'unresolved','unresolved','held','ordinary',NULL,'raw claim',NULL,'original')").run(id);
}
test("read preserves exact strings, integer width and table/view distinction", () => {
  fixture(db => {
    insert(db, "b"); insert(db, "a");
    db.exec("UPDATE cdr_async_execution_obligations SET revision=9223372036854775807 WHERE question_id='a'");
    const rows = readAsyncObligationsIn(db, "target");
    assert.deepEqual(rows.map(r => r.question_id), ["a", "b"]);
    assert.equal(rows[0]!.revision, 9223372036854775807n); assert.equal(rows[0]!.claim, "raw claim");
    db.exec("UPDATE cdr_async_execution_obligations SET admission_state='settled'");
    assert.equal(readAsyncObligationsIn(db, "target").length, 0);
    assert.equal(readAsyncObligationsIn(db, "target", false).length, 2);
    assert.deepEqual(readAsyncObligationsIn(db, "other"), []);
  });
});
test("claim digest uses exact UTF-8 length-prefixed nullable domains", () => {
  const bytes = Buffer.from([1,3,0,0,0,0,0,0,0,0xed,0x95,0x9c,0,1,0,0,0,0,0,0,0,0]);
  assert.equal(asyncClaimDigest("한", null, ""), createHash("sha256").update(bytes).digest("hex"));
  assert.notEqual(asyncClaimDigest("ab", "c", null), asyncClaimDigest("a", "bc", null));
  assert.notEqual(asyncClaimDigest("a", null, null), asyncClaimDigest("a", "", null));
});
test("missing ledger skips view; present ledger missing view throws native error", () => {
  const db = new DatabaseSync(":memory:");
  try { assert.deepEqual(readAsyncObligationsIn(db, "target"), []); }
  finally { db.close(); }
  fixture(db => { db.exec("DROP VIEW cdr_async_unsettled_obligations"); assert.throws(() => readAsyncObligationsIn(db,"target"), /no such table/); });
});
test("128 records accepted, 129 decoded before limit error, later rows never read", () => {
  fixture(db => {
    for (let i=0;i<128;i++) insert(db, String(i).padStart(3,"0"));
    assert.equal(readAsyncObligationsIn(db,"target").length,128);
    insert(db,"128"); assert.throws(() => readAsyncObligationsIn(db,"target"), /bounded review limit/);
    db.exec("UPDATE cdr_async_execution_obligations SET claim_json=CAST(x'80' AS TEXT) WHERE question_id='128'");
    assert.throws(() => readAsyncObligationsIn(db,"target"), /Invalid SQLite text encoding for claim_json/);
    db.exec("DELETE FROM cdr_async_execution_obligations WHERE question_id='128'");
    insert(db,"129"); insert(db,"130");
    db.exec("UPDATE cdr_async_execution_obligations SET claim_json=CAST(x'80' AS TEXT) WHERE question_id='130'");
    assert.throws(() => readAsyncObligationsIn(db,"target"), /bounded review limit/);
  });
});
test("claim/seal/owner decode errors precede identity and integer errors", () => {
  fixture(db => {
    insert(db);
    db.exec("UPDATE cdr_async_execution_obligations SET question_id=x'80',revision='bad',claim_json=CAST(x'80' AS TEXT)");
    assert.throws(() => readAsyncObligationsIn(db,"target"), /encoding for claim_json/);
    db.exec("UPDATE cdr_async_execution_obligations SET claim_json='ok',original_seal=1");
    assert.throws(() => readAsyncObligationsIn(db,"target"), /TEXT for original_seal/);
  });
});
test("UTF-16 database text is hashed as decoded UTF-8 and reads preserve outer transaction", () => {
  for (const encoding of ["UTF-8","UTF-16le","UTF-16be"]) fixture(db => {
    insert(db); db.prepare("UPDATE cdr_async_execution_obligations SET claim_json=?").run("한😀");
    db.exec("BEGIN"); const row = readAsyncObligationsIn(db,"target")[0]!;
    assert.equal(row.claim,"한😀"); assert.equal(row.claim_sha256,asyncClaimDigest("한😀",null,null));
    assert.equal(db.isTransaction,true); db.exec("ROLLBACK");
  },encoding);
});
