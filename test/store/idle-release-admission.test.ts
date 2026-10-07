import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrateIdleRelease } from "../../src/store/schema-extensions-a.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";
import { beforeEnqueue } from "../../src/store/idle-release-admission.ts";

function fixture(encoding="UTF-8"): DatabaseSync {
  const db=new DatabaseSync(":memory:");
  db.exec(`PRAGMA encoding='${encoding}';`);
  migrateIdleRelease(db);
  return db;
}
function insert(db: DatabaseSync, state: string, thread="thread😀"): void {
  db.prepare(`INSERT INTO cdr_idle_release
    (intent_id,owner_id,generation,thread_id,turn_id,job_id,revision,state,detail)
    VALUES ('intent','owner',?,?,?,?,7,?,'reason')`)
    .run(9007199254740993n,thread,"turn","job",state);
}
test("missing intent is a borrowed no-op",()=>{
  const db=fixture();
  try { beforeEnqueue(db,"absent"); assert.equal(db.isTransaction,false); }
  finally { db.close(); }
});
for(const encoding of ["UTF-8","UTF-16le","UTF-16be"]) {
  test(`candidate cancellation preserves exact identity in ${encoding}`,()=>{
    const db=fixture(encoding);
    try {
      insert(db,"Candidate");
      db.exec("BEGIN IMMEDIATE");
      beforeEnqueue(db,"thread😀");
      assert.equal(db.isTransaction,true);
      const stmt=db.prepare("SELECT * FROM cdr_idle_release");stmt.setReadBigInts(true);
      const row=stmt.get()!;
      assert.deepEqual({...row},{
        intent_id:"intent",owner_id:"owner",generation:9007199254740993n,
        thread_id:"thread😀",turn_id:"turn",job_id:"job",revision:8n,
        state:"Settled",detail:"CancelledBeforeSend",
      });
      db.exec("ROLLBACK");
      assert.equal(db.prepare("SELECT state FROM cdr_idle_release").get()!.state,"Candidate");
    } finally { db.close(); }
  });
}
for(const state of ["Settled","AwaitUnload"]) {
  test(`${state} permits enqueue without row mutation`,()=>{
    const db=fixture();
    try {
      insert(db,state);
      const stmt=db.prepare("SELECT * FROM cdr_idle_release");stmt.setReadBigInts(true);
      const before=stmt.get();
      beforeEnqueue(db,"thread😀");
      assert.deepEqual(stmt.get(),before);
    } finally { db.close(); }
  });
}
for(const state of ["Dispatching","Resubscribing","Unknown"]) {
  test(`${state} refuses without changing custody`,()=>{
    const db=fixture();
    try {
      insert(db,state);
      const stmt=db.prepare("SELECT * FROM cdr_idle_release");stmt.setReadBigInts(true);
      const before=stmt.get();
      assert.throws(()=>beforeEnqueue(db,"thread😀"),(error: unknown)=>{
        assert.ok(error instanceof StoreIntegrityError);
        assert.equal(error.result,`idle release ${state} requires review for thread thread😀; new prompt was not enqueued: reason`);
        return true;
      });
      assert.deepEqual(stmt.get(),before);
    } finally { db.close(); }
  });
}
test("failed compare-and-set refuses and leaves caller transaction active",()=>{
  const db=fixture();
  try {
    insert(db,"Candidate");
    db.exec("CREATE TRIGGER prevent_update BEFORE UPDATE ON cdr_idle_release BEGIN SELECT RAISE(IGNORE); END; BEGIN IMMEDIATE;");
    assert.throws(()=>beforeEnqueue(db,"thread😀"),/idle release compare-and-set lost/);
    assert.equal(db.isTransaction,true);
    assert.equal(db.prepare("SELECT state FROM cdr_idle_release").get()!.state,"Candidate");
    db.exec("ROLLBACK");
  } finally { db.close(); }
});
test("typed select rejects corrupt unused identity before mutation",()=>{
  const db=fixture();
  try {
    insert(db,"Candidate");
    db.exec("UPDATE cdr_idle_release SET generation='bad';");
    assert.throws(()=>beforeEnqueue(db,"thread😀"),StoreIntegrityError);
    assert.equal(db.prepare("SELECT state FROM cdr_idle_release").get()!.state,"Candidate");
  } finally { db.close(); }
});
test("malformed UTF8 in an identity refuses before mutation",()=>{
  const db=fixture();
  try {
    insert(db,"Candidate");
    db.exec("UPDATE cdr_idle_release SET owner_id=CAST(X'80' AS TEXT);");
    assert.throws(()=>beforeEnqueue(db,"thread😀"),StoreIntegrityError);
    assert.equal(db.prepare("SELECT state FROM cdr_idle_release").get()!.state,"Candidate");
  } finally { db.close(); }
});
test("malformed thread input is rejected before connection access",()=>{
  const db=new DatabaseSync(":memory:");db.close();
  assert.throws(()=>beforeEnqueue(db,"\uD800"),TypeError);
});

test("unknown persisted state refuses without mutation",()=>{
  const db=fixture();
  try {
    db.exec("PRAGMA ignore_check_constraints=ON");
    insert(db,"Unexpected");
    assert.throws(()=>beforeEnqueue(db,"thread😀"),/idle release Unexpected requires review/);
    assert.equal(db.prepare("SELECT state FROM cdr_idle_release").get()!.state,"Unexpected");
  } finally { db.close(); }
});
test("revision arithmetic stays SQLite-owned at the signed i64 boundary",()=>{
  const db=fixture();
  try {
    insert(db,"Candidate");
    db.prepare("UPDATE cdr_idle_release SET revision=?").run(9223372036854775807n);
    beforeEnqueue(db,"thread😀");
    const row=db.prepare("SELECT state,typeof(revision) AS kind FROM cdr_idle_release").get()!;
    assert.equal(row.state,"Settled");
    assert.equal(row.kind,"real");
    assert.throws(()=>beforeEnqueue(db,"thread😀"),StoreIntegrityError);
  } finally { db.close(); }
});