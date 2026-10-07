import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import { openExisting } from "../../src/store/existing-store.ts";
import { openInitialized, initialize } from "../../src/store/owned-driver.ts";
import { list, listFiltered, StoreIntegrityError, selectJob, allJobs } from "../../src/store/queue-read.ts";

const SYSTEM_TMP = resolve(realpathSync(tmpdir()));
const trackedTempDirs: string[] = [];
const trackedDbHandles: DatabaseSync[] = [];

function createTempFixtureDir(): string {
  const dir = mkdtempSync(join(SYSTEM_TMP, "cdr-ts-queue-file-"));
  const resolved = resolve(realpathSync(dir));
  trackedTempDirs.push(resolved);
  return resolved;
}

function safeRemoveTempDir(dir: string): void {
  const resolved = resolve(dir);
  const currentReal = resolve(realpathSync(dir));
  const isWindows = process.platform === "win32";

  const matchesTracked = isWindows
    ? currentReal.toLowerCase() === resolved.toLowerCase()
    : currentReal === resolved;

  const currentParent = resolve(dirname(currentReal));
  const currentTmp = resolve(realpathSync(tmpdir()));
  const matchesParent = isWindows
    ? currentParent.toLowerCase() === currentTmp.toLowerCase()
    : currentParent === currentTmp;

  const base = basename(currentReal);

  if (matchesTracked && matchesParent && base.startsWith("cdr-ts-queue-file-")) {
    rmSync(currentReal, { recursive: true, force: true });
  } else {
    throw new Error(`Refusing to remove directory outside expected tmpdir pattern: ${resolved}`);
  }
}

describe("queue file-backed operations", () => {
  afterEach(() => {
    for (const db of trackedDbHandles) {
      try {
        db.close();
      } catch {
        // ignore close error on cleanup
      }
    }
    trackedDbHandles.length = 0;

    for (const dir of trackedTempDirs) {
      safeRemoveTempDir(dir);
    }
    trackedTempDirs.length = 0;
  });

  for (const encoding of ["UTF-8", "UTF-16le", "UTF-16be"] as const) {
    it(`reads valid ${encoding} stores without changing encoding`, async () => {
      const dir = createTempFixtureDir();
      const path = join(dir, "encoding.sqlite");
      const db = new DatabaseSync(path);
      trackedDbHandles.push(db);
      db.exec(`PRAGMA encoding='${encoding}';`);
      await initialize(db, path);
      assert.equal(db.prepare("PRAGMA encoding").get()!.encoding, encoding);
      const prompt = "\uFEFF한글😀a\u0000b";
      db.prepare(`
        INSERT INTO codex_turn_queue (
          job_id, target_thread_id, channel_id, app_server_generation,
          prompt, queued, ack_sent, state, attempt_count,
          baseline_turn_ids, last_error, created_at, updated_at
        ) VALUES (?, ?, 1, 100, ?, 1, 0, 'pending', 0, ?, '', 1000, 1000)
      `).run("j", "대상😀", prompt, '["한글","😀"]');
      const expected = selectJob(db, "j");
      assert.equal(expected.prompt, prompt);
      assert.deepEqual(expected.baselineTurnIds, ["한글", "😀"]);
      assert.deepEqual(allJobs(db), [expected]);
      db.close();
      trackedDbHandles.splice(trackedDbHandles.indexOf(db), 1);
      assert.deepEqual(await list(path), [expected]);
      for (const [target, generation] of [
        [null, null], ["대상😀", null], [null, 100n], ["대상😀", 100n],
      ] as const) {
        assert.deepEqual(await listFiltered(path, target, generation), [expected]);
      }
      const verify = openExisting(path);
      try {
        assert.equal(verify.prepare("PRAGMA encoding").get()!.encoding, encoding);
      } finally { verify.close(); }
    });
  }

  for (const encoding of ["UTF-16le", "UTF-16be"] as const) {
    const cases: Array<[number[], string | null]> = [[[0,216,65,0],"𐁁"],[[0,220,65,0],"𐁁"],[[0,216,0,216],"𐀀"],[[0,220,0,216],"𐀀"],[[0,216],null],[[0,220],null],[[65,0,255],"A"],[[255],""],[[0,0],"\u0000"],[[255,254,65,0],"﻿A"],[[61,216,0,222],"😀"]];
    for (const [index, [little, expected]] of cases.entries()) {
      it(`matches SQLite/Rust malformed UTF16 conversion: ${encoding} case ${index}`, async () => {
        const dir = createTempFixtureDir();
        const path = join(dir, "malformed.sqlite");
        const db = new DatabaseSync(path);
        trackedDbHandles.push(db);
        db.exec(`PRAGMA encoding='${encoding}';`);
        await initialize(db, path);
        const bytes = Uint8Array.from(little);
        if (encoding === "UTF-16be") {
          for (let i=0; i+1<bytes.length; i+=2) {
            const previous=bytes[i]!;
            bytes[i]=bytes[i+1]!;
            bytes[i+1]=previous;
          }
        }
        db.prepare(`INSERT INTO codex_turn_queue (
          job_id,target_thread_id,channel_id,app_server_generation,prompt,
          queued,ack_sent,state,attempt_count,baseline_turn_ids,last_error,created_at,updated_at
        ) VALUES ('j','t',1,100,CAST(? AS TEXT),1,0,'pending',0,'[]','',0,0)`).run(bytes);
        if (expected === null) {
          assert.throws(() => selectJob(db,"j"),StoreIntegrityError);
          assert.throws(() => allJobs(db),StoreIntegrityError);
        } else {
          assert.equal(selectJob(db,"j").prompt,expected);
          assert.equal(allJobs(db)[0]!.prompt,expected);
        }
        db.close();
        trackedDbHandles.splice(trackedDbHandles.indexOf(db),1);
        if (expected === null) {
          await assert.rejects(() => list(path),StoreIntegrityError);
          await assert.rejects(() => listFiltered(path,"t",100n),StoreIntegrityError);
        } else {
          assert.equal((await list(path))[0]!.prompt,expected);
          assert.equal((await listFiltered(path,"t",100n))[0]!.prompt,expected);
        }
      });
    }
  }

  it("exact observed filters/rows", async () => {
    const tempDir = createTempFixtureDir();
    const dbPath = join(tempDir, "queue #%& 測試 test.sqlite");

    const db = await openInitialized(dbPath);
    trackedDbHandles.push(db);

    const insertStmt = db.prepare(`
      INSERT INTO codex_turn_queue (
        job_id, target_thread_id, channel_id, discord_message_id,
        app_server_generation, prompt, queued, ack_sent, state,
        attempt_count, baseline_turn_ids, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const channelId = 9_007_199_254_740_993n;
    insertStmt.run("job-b", "t1", channelId, null, 200n, "prompt b", 1n, 0n, "pending", 0n, "[]", "", 1000, 1000);
    insertStmt.run("job-a", "t1", channelId, null, 100n, "prompt a", 1n, 0n, "pending", 0n, "[]", "", 1000, 1000);
    insertStmt.run("job-d", "t2", channelId, null, 200n, "prompt d", 1n, 0n, "pending", 0n, "[]", "", 2000, 2000);
    insertStmt.run("job-c", "t2", channelId, null, 100n, "prompt c", 1n, 0n, "pending", 0n, "[]", "", 2000, 2000);

    db.close();
    const dbIdx = trackedDbHandles.indexOf(db);
    if (dbIdx !== -1) trackedDbHandles.splice(dbIdx, 1);

    const all = await list(dbPath);
    assert.strictEqual(all.length, 4);
    assert.deepStrictEqual(
      all.map((j) => j.jobId),
      ["job-a", "job-b", "job-c", "job-d"],
    );

    const j0 = all[0];
    assert.ok(j0 !== undefined);
    assert.strictEqual(typeof j0.channelId, "bigint");
    assert.strictEqual(j0.channelId, channelId);
    assert.strictEqual(j0.channelId > 2n ** 53n, true);
    assert.strictEqual(j0.appServerGeneration, 100n);
    assert.strictEqual(j0.attemptCount, 0n);
    assert.strictEqual(j0.discordMessageId, null);
    assert.strictEqual(j0.ownerUserId, null);
    assert.strictEqual(j0.executionGeneration, null);
    assert.strictEqual(j0.turnObservationGeneration, null);
    assert.strictEqual(j0.goalWaiting, false);

    const f1 = await listFiltered(dbPath, "t1", 100n);
    assert.deepStrictEqual(f1.map((j) => j.jobId), ["job-a"]);

    const f2 = await listFiltered(dbPath, "t1", null);
    assert.deepStrictEqual(f2.map((j) => j.jobId), ["job-a", "job-b"]);

    const f3 = await listFiltered(dbPath, null, 100n);
    assert.deepStrictEqual(f3.map((j) => j.jobId), ["job-a", "job-c"]);

    const f4 = await listFiltered(dbPath, null, null);
    assert.deepStrictEqual(f4.map((j) => j.jobId), ["job-a", "job-b", "job-c", "job-d"]);
    assert.deepStrictEqual(all, f4);

    const verifyDb = openExisting(dbPath);
    trackedDbHandles.push(verifyDb);
    const row = verifyDb.prepare("SELECT COUNT(*) AS cnt FROM codex_turn_queue").get() as { cnt: number | bigint };
    assert.strictEqual(Number(row.cnt), 4);
    verifyDb.close();
    const vIdx = trackedDbHandles.indexOf(verifyDb);
    if (vIdx !== -1) trackedDbHandles.splice(vIdx, 1);
  });

  it("rejects malformed target and out-of-range generation before DB creation", async () => {
    const tempDir = createTempFixtureDir();
    const absentPath = join(tempDir, "absent #%& 測試.sqlite");
    assert.strictEqual(existsSync(absentPath), false);

    await assert.rejects(() => listFiltered(absentPath, "\uD800", 100n), TypeError);
    assert.strictEqual(existsSync(absentPath), false);

    await assert.rejects(() => listFiltered(absentPath, "t1", 9_223_372_036_854_775_808n), RangeError);
    assert.strictEqual(existsSync(absentPath), false);

    await assert.rejects(() => listFiltered(absentPath, "t1", -9_223_372_036_854_775_809n), RangeError);
    assert.strictEqual(existsSync(absentPath), false);
  });

  it("failure/reopen/correct/reread", async () => {
    const tempDir = createTempFixtureDir();
    const badPath = join(tempDir, "corrupt #%& 測試.sqlite");

    const badDb = await openInitialized(badPath);
    trackedDbHandles.push(badDb);
    badDb.prepare(`
      INSERT INTO codex_turn_queue (
        job_id, target_thread_id, channel_id, discord_message_id,
        app_server_generation, prompt, queued, ack_sent, state,
        attempt_count, baseline_turn_ids, last_error, created_at, updated_at
      ) VALUES ('bad-1', 't1', 1, NULL, 100, CAST(X'80' AS TEXT), 1, 0, 'pending', 0, '[]', '', 1000, 1000)
    `).run();
    badDb.close();
    const bIdx = trackedDbHandles.indexOf(badDb);
    if (bIdx !== -1) trackedDbHandles.splice(bIdx, 1);

    await assert.rejects(() => list(badPath), StoreIntegrityError);

    const fixDb = openExisting(badPath);
    trackedDbHandles.push(fixDb);
    fixDb.prepare("UPDATE codex_turn_queue SET prompt = 'corrected' WHERE job_id = 'bad-1'").run();
    fixDb.close();
    const fIdx = trackedDbHandles.indexOf(fixDb);
    if (fIdx !== -1) trackedDbHandles.splice(fIdx, 1);

    const repaired = await list(badPath);
    assert.strictEqual(repaired.length, 1);
    const r0 = repaired[0];
    assert.ok(r0 !== undefined);
    assert.strictEqual(r0.prompt, "corrected");
  });
});
