import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";
import {
  ensureForkHandoffTable,ensureNoUnresolvedHandoff,ensureSourceNotMoved,
  ForkHandoffUnresolvedError,ForkHandoffTargetMovedError,
} from "../../src/store/fork-handoff-admission.ts";
function fixture(): DatabaseSync {
  const db=new DatabaseSync(":memory:");ensureForkHandoffTable(db);return db;
}
function insert(db: DatabaseSync, target: string | null, error=""): void {
  db.prepare("INSERT INTO codex_thread_fork_handoffs (handoff_id,ambiguous_job_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,last_fork_error,fork_failure_ambiguous,observed_target_thread_id,target_thread_id,completed_generation,created_at,completed_at) VALUES ('h',NULL,'source',1,2,3,'reason',?,0,?,?,?,0,?)")
    .run(error,target,target,target===null?null:4n,target===null?null:1);
}
test("missing handoff is permitted and table creation follows caller rollback",()=>{
  const db=new DatabaseSync(":memory:");
  try {
    db.exec("BEGIN IMMEDIATE");
    ensureNoUnresolvedHandoff(db,"source");
    assert.equal(db.isTransaction,true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='codex_thread_fork_handoffs'").get()!.n,1);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='codex_thread_fork_handoffs'").get()!.n,0);
  } finally {db.close();}
});
test("unresolved handoff remains blocked even with retirement table present",()=>{
  const db=fixture();
  try {
    insert(db,null,"prior failure");
    db.exec("CREATE TABLE codex_exact_thread_routing(enabled INTEGER)");
    assert.throws(()=>ensureNoUnresolvedHandoff(db,"source"),(error: unknown)=>{
      assert.ok(error instanceof ForkHandoffUnresolvedError);
      assert.equal(error.targetThreadId,"source");
      assert.equal(error.lastError,"prior failure");
      assert.equal(error.message,'app-server fork handoff is unresolved for target thread source: Some("prior failure")');
      return true;
    });
    ensureSourceNotMoved(db,"source");
  } finally {db.close();}
});
for(const whitespace of ["","\u0085","\u2000\u3000\r\n"]) {
  test("Rust whitespace-only last error becomes None: "+JSON.stringify(whitespace),()=>{
    const db=fixture();
    try {
      insert(db,null,whitespace);
      assert.throws(()=>ensureNoUnresolvedHandoff(db,"source"),(error: unknown)=>{
        assert.ok(error instanceof ForkHandoffUnresolvedError);
        assert.equal(error.lastError,null);
        assert.equal(error.message,"app-server fork handoff is unresolved for target thread source: None");
        return true;
      });
    } finally {db.close();}
  });
}
test("BOM is not Rust whitespace and diagnostic uses Rust Debug",()=>{
  const db=fixture();
  try {
    insert(db,null,"\uFEFF");
    assert.throws(()=>ensureNoUnresolvedHandoff(db,"source"),(error: unknown)=>{
      assert.ok(error instanceof ForkHandoffUnresolvedError);
      assert.equal(error.lastError,"\uFEFF");
      assert.equal(error.message,'app-server fork handoff is unresolved for target thread source: Some("\\u{feff}")');
      return true;
    });
  } finally {db.close();}
});
test("completed handoff passes unresolved check but moved-source check refuses",()=>{
  const db=fixture();
  try {
    insert(db,"target😀");
    ensureNoUnresolvedHandoff(db,"source");
    assert.throws(()=>ensureSourceNotMoved(db,"source"),(error: unknown)=>{
      assert.ok(error instanceof ForkHandoffTargetMovedError);
      assert.equal(error.sourceThreadId,"source");
      assert.equal(error.targetThreadId,"target😀");
      assert.equal(error.message,"app-server fork handoff moved source thread source to target😀");
      return true;
    });
    ensureSourceNotMoved(db,"other");
  } finally {db.close();}
});
test("retirement is table-presence based, not row-content based, and bypasses schema ensure",()=>{
  const db=new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE codex_exact_thread_routing(enabled INTEGER)");
    ensureSourceNotMoved(db,"source");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='codex_thread_fork_handoffs'").get()!.n,0);
  } finally {db.close();}
});
test("all typed handoff fields decode before completed-row filtering",()=>{
  const db=fixture();
  try {
    insert(db,"target");
    db.exec("UPDATE codex_thread_fork_handoffs SET expected_generation='bad'");
    assert.throws(()=>ensureNoUnresolvedHandoff(db,"source"),StoreIntegrityError);
  } finally {db.close();}
});
test("legacy missing columns are added and obsolete index removed",()=>{
  const db=new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE codex_thread_fork_handoffs (handoff_id TEXT PRIMARY KEY,ambiguous_job_id TEXT UNIQUE,source_thread_id TEXT NOT NULL UNIQUE,expected_generation INTEGER NOT NULL,discord_channel_id INTEGER NOT NULL,discord_thread_id INTEGER NOT NULL,quarantine_reason TEXT NOT NULL,target_thread_id TEXT UNIQUE,completed_generation INTEGER,created_at REAL NOT NULL,completed_at REAL); CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs(source_thread_id);");
    ensureForkHandoffTable(db);
    const names=db.prepare("PRAGMA table_info(codex_thread_fork_handoffs)").all().map(r=>r.name);
    for(const name of ["observed_target_thread_id","last_fork_error","fork_failure_ambiguous"]) assert.ok(names.includes(name));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='codex_thread_fork_handoffs_observed_target'").get()!.n,0);
  } finally {db.close();}
});
test("malformed input is refused before touching a closed connection",()=>{
  const db=new DatabaseSync(":memory:");db.close();
  assert.throws(()=>ensureNoUnresolvedHandoff(db,"\uD800"),TypeError);
  assert.throws(()=>ensureSourceNotMoved(db,"\uDFFF"),TypeError);
});
