import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { openInitialized } from "../../src/store/owned-driver.ts";
import { StateAccessFacade } from "../../src/store/state-access-facade.ts";
import { REVIEWED_INCIDENT_THREAD } from "../../src/store/async-resolution-policy.ts";

async function fixture(run: (path: string) => Promise<void>): Promise<void> {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, "cdr-cloud-admission-"));
  const initial = realpathSync(root);
  try { await run(join(root, "store.sqlite")); }
  finally {
    assert.equal(realpathSync(root), initial);
    assert.equal(dirname(initial), parent);
    rmSync(root, { recursive: true });
  }
}

test("owned facade read creates real schema and closes first handle before second", async ctx => {
  await fixture(async path => {
    const initial = await openInitialized(path); initial.close();
    const originalClose = DatabaseSync.prototype.close;
    const originalPrepare = DatabaseSync.prototype.prepare;
    const closed: DatabaseSync[] = [];
    let startQueries = 0;
    ctx.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
      if (sql.includes("dispatch_mode='start'")) {
        startQueries++;
        assert.equal(closed.length, 1);
        assert.equal(closed[0]?.isOpen, false);
      }
      return originalPrepare.call(this, sql);
    });
    ctx.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
      originalClose.call(this); closed.push(this);
    });
    assert.equal(await StateAccessFacade.asyncTargetDispatchHeld(path, "t"), false);
    assert.equal(closed.length, 2);
    assert.equal(startQueries, 1);
    assert.notEqual(closed[0], closed[1]);
    assert.equal(closed.every(db => !db.isOpen), true);
    closed.length = 0;
    assert.equal(await StateAccessFacade.asyncTargetDispatchHeld(path, REVIEWED_INCIDENT_THREAD), true);
    assert.equal(closed.length, 1);
    assert.equal(startQueries, 1);
    assert.equal(closed[0]?.isOpen, false);
  });
});

test("real initialized store separates start dispatch from steer and unrelated threads", async () => {
  await fixture(async path => {
    const db = await openInitialized(path);
    try {
      db.prepare(`INSERT INTO cdr_async_questions
        (id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,
         owner_user_id,body,state,dispatch_mode,created_at,updated_at)
        VALUES ('q','r',1,'target','turn','item','job',1,1,'{}','dispatching','start',0,0)`).run();
    } finally { db.close(); }
    assert.equal(await StateAccessFacade.asyncAdmissionHeld(path, "target"), false);
    assert.equal(await StateAccessFacade.asyncTargetDispatchHeld(path, "target"), true);
    assert.equal(await StateAccessFacade.asyncTargetDispatchHeld(path, "other"), false);
    const edit = await openInitialized(path);
    try { edit.exec("UPDATE cdr_async_questions SET dispatch_mode='steer'"); }
    finally { edit.close(); }
    assert.equal(await StateAccessFacade.asyncAdmissionHeld(path, "target"), true);
    assert.equal(await StateAccessFacade.asyncTargetDispatchHeld(path, "target"), true);
  });
});

test("invalid input does not create a database; native open errors reject", async () => {
  await fixture(async path => {
    await assert.rejects(StateAccessFacade.asyncTargetDispatchHeld(path, "\ud800"), TypeError);
    assert.equal(existsSync(path), false);
    await assert.rejects(StateAccessFacade.asyncTargetDispatchHeld(join(path, "missing.sqlite"), "t"));
    assert.equal(existsSync(path), false);
  });
});
