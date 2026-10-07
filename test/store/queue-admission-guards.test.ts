import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrateIngress } from "../../src/store/schema-extensions-b2.ts";
import { migrateAsyncQuestion } from "../../src/store/schema-extensions-a.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";
import { requireUnheldOriginIn, requireUnheldKeyIn, asyncQuestionDispatchHeldIn } from "../../src/store/queue-admission-guards.ts";

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateIngress(db);
  migrateAsyncQuestion(db);
  return db;
}
function ingress(db: DatabaseSync, key: string, event: bigint | null, outcome: string | null): void {
  db.prepare(`INSERT INTO discord_ingress_journal
    (ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,outcome_json,created_at,updated_at)
    VALUES (?,'message',?,1,2,'{}','completed','done',?,0,0)`).run(key,event,outcome);
}
test("null origin is a no-query no-op even on a closed connection", () => {
  const db = new DatabaseSync(":memory:"); db.close();
  assert.doesNotThrow(() => requireUnheldOriginIn(db,null));
});
test("missing stop marker permits matching and absent origins and keys", () => {
  const db=fixture();
  try {
    ingress(db,"a",1n,null); ingress(db,"b",2n,"{}");
    for(const event of [1n,2n,3n]) requireUnheldOriginIn(db,event);
    for(const key of ["a","b","absent"]) requireUnheldKeyIn(db,key);
  } finally { db.close(); }
});
for(const value of ["null","false","0",'""',"{}","[]"]) {
  test(`any present stop_hold JSON type blocks: ${value}`, () => {
    const db=fixture();
    try {
      ingress(db,"held",9007199254740993n,`{"stop_hold":${value}}`);
      assert.throws(()=>requireUnheldOriginIn(db,9007199254740993n),StoreIntegrityError);
      assert.throws(()=>requireUnheldKeyIn(db,"held"),StoreIntegrityError);
      requireUnheldOriginIn(db,9007199254740992n);
      requireUnheldKeyIn(db,"other");
    } finally { db.close(); }
  });
}
test("invalid JSON remains a database failure rather than a false unheld result", () => {
  const db=fixture();
  try {
    ingress(db,"bad",1n,"{");
    assert.throws(()=>requireUnheldOriginIn(db,1n));
    assert.throws(()=>requireUnheldKeyIn(db,"bad"));
  } finally { db.close(); }
});
test("guards preserve caller transaction and observe its pending writes", () => {
  const db=fixture();
  try {
    db.exec("BEGIN IMMEDIATE");
    ingress(db,"held",1n,'{"stop_hold":null}');
    assert.throws(()=>requireUnheldOriginIn(db,1n),StoreIntegrityError);
    assert.equal(db.isTransaction,true);
    db.exec("ROLLBACK");
    requireUnheldOriginIn(db,1n);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM discord_ingress_journal").get()!.n,0);
  } finally { db.close(); }
});
test("dispatch guard requires exact target, start mode and dispatching state", () => {
  const db=fixture();
  try {
    const insert=db.prepare(`INSERT INTO cdr_async_questions
      (id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,state,dispatch_mode,created_at,updated_at)
      VALUES (?,'r',1,?,'turn','item','job',1,2,'{}',?,?,0,0)`);
    insert.run("a","target","dispatching","start");
    insert.run("b","other","dispatching","steer");
    insert.run("c","third","submitted","start");
    assert.equal(asyncQuestionDispatchHeldIn(db,"target"),true);
    for(const target of ["other","third","absent"]) assert.equal(asyncQuestionDispatchHeldIn(db,target),false);
    assert.equal(db.isTransaction,false);
  } finally { db.close(); }
});
test("malformed strings and non-i64 origins are rejected before database access", () => {
  const db=new DatabaseSync(":memory:"); db.close();
  assert.throws(()=>requireUnheldKeyIn(db,"\uD800"),TypeError);
  assert.throws(()=>asyncQuestionDispatchHeldIn(db,"\uDFFF"),TypeError);
  assert.throws(()=>requireUnheldOriginIn(db,9223372036854775808n),TypeError);
});