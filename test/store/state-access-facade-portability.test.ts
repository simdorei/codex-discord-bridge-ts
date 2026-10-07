import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  StateAccessFacade,
  enqueue,
  openCheckedRead,
} from "../../src/store/state-access-facade.ts";
import * as QueueEnqueue from "../../src/store/queue-enqueue.ts";
import type { NewQueueJob } from "../../src/store/queue-enqueue.ts";
import { CheckedRead, openInitialized } from "../../src/store/owned-driver.ts";

const execFileAsync = promisify(execFile);

const CHILD_SNIPPET = `
import assert from "node:assert/strict";

const structuredArgs = process.argv.slice(1).filter((a) => a !== "[eval]" && a !== "--");
const [facadeUrl, leafUrl, driverUrl, dbPath] = structuredArgs;

const facade = await import(facadeUrl);
const leaf = await import(leafUrl);
const driver = await import(driverUrl);

assert.strictEqual(facade.enqueue, leaf.enqueue);
assert.strictEqual(facade.StateAccessFacade.enqueue, leaf.enqueue);
assert.strictEqual(facade.openCheckedRead, driver.CheckedRead.open);
assert.strictEqual(facade.StateAccessFacade.openCheckedRead, driver.CheckedRead.open);

const readDb = await driver.openInitialized(dbPath);
try {
  const stmt = readDb.prepare(
    "SELECT job_id, target_thread_id, prompt, state FROM codex_turn_queue WHERE job_id = ?",
  );
  const row1 = stmt.get("job-port-alpha-001");
  assert.deepStrictEqual({ ...row1 }, {
    job_id: "job-port-alpha-001",
    target_thread_id: "thread-port-alpha",
    prompt: "synthetic portability prompt alpha ⚡",
    state: "pending",
  });
  const row2 = stmt.get("job-port-beta-002");
  assert.deepStrictEqual({ ...row2 }, {
    job_id: "job-port-beta-002",
    target_thread_id: "thread-port-beta",
    prompt: "synthetic portability prompt beta ✨",
    state: "pending",
  });
} finally {
  readDb.close();
}

const dupResult = await facade.enqueue(dbPath, {
  jobId: "job-port-alpha-dup",
  targetThreadId: "thread-port-alpha",
  channelId: 9007199254740995n,
  ownerUserId: 10001n,
  discordMessageId: 20001n,
  appServerGeneration: 2n,
  prompt: "mutated prompt that must not overwrite existing row",
  queued: true,
  ackSent: false,
  createdAt: 1700000003000,
});
assert.strictEqual(dupResult.created, false);
assert.strictEqual(dupResult.job.jobId, "job-port-alpha-001");
assert.strictEqual(dupResult.job.prompt, "synthetic portability prompt alpha ⚡");

const verifyDb = await driver.openInitialized(dbPath);
try {
  const row = verifyDb.prepare(
    "SELECT prompt FROM codex_turn_queue WHERE job_id = ?",
  ).get("job-port-alpha-001");
  assert.strictEqual(row.prompt, "synthetic portability prompt alpha ⚡");
} finally {
  verifyDb.close();
}
`;

test("facade reference identity and cross-process persistence proof", async () => {
  const tmpRoot = resolve(realpathSync(tmpdir()));
  const fixtureDir = mkdtempSync(join(tmpRoot, "cdr-facade-port-"));
  const initialRealDir = resolve(realpathSync(fixtureDir));
  const dbPath = join(initialRealDir, "portability.sqlite");

  try {
    const initDb = await openInitialized(dbPath);
    try {
      assert.strictEqual(initDb.isTransaction, false);
    } finally {
      initDb.close();
    }

    assert.strictEqual(StateAccessFacade.enqueue, QueueEnqueue.enqueue);
    assert.strictEqual(enqueue, QueueEnqueue.enqueue);
    assert.strictEqual(StateAccessFacade.openCheckedRead, CheckedRead.open);
    assert.strictEqual(openCheckedRead, CheckedRead.open);

    const job1: NewQueueJob = {
      jobId: "job-port-alpha-001",
      targetThreadId: "thread-port-alpha",
      channelId: 9007199254740995n,
      ownerUserId: 10001n,
      discordMessageId: 20001n,
      appServerGeneration: 1n,
      prompt: "synthetic portability prompt alpha ⚡",
      queued: true,
      ackSent: false,
      createdAt: 1700000001000,
    };
    const job2: NewQueueJob = {
      jobId: "job-port-beta-002",
      targetThreadId: "thread-port-beta",
      channelId: 9007199254740996n,
      ownerUserId: 10002n,
      discordMessageId: 20002n,
      appServerGeneration: 1n,
      prompt: "synthetic portability prompt beta ✨",
      queued: true,
      ackSent: false,
      createdAt: 1700000002000,
    };

    const res1 = await enqueue(dbPath, job1);
    assert.strictEqual(res1.created, true);
    assert.strictEqual(res1.job.jobId, job1.jobId);
    assert.strictEqual(res1.job.targetThreadId, job1.targetThreadId);

    const res2 = await StateAccessFacade.enqueue(dbPath, job2);
    assert.strictEqual(res2.created, true);
    assert.strictEqual(res2.job.jobId, job2.jobId);
    assert.strictEqual(res2.job.targetThreadId, job2.targetThreadId);

    const facadeUrl = new URL("../../src/store/state-access-facade.ts", import.meta.url).href;
    const leafUrl = new URL("../../src/store/queue-enqueue.ts", import.meta.url).href;
    const driverUrl = new URL("../../src/store/owned-driver.ts", import.meta.url).href;

    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", CHILD_SNIPPET, facadeUrl, leafUrl, driverUrl, dbPath],
      { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 65536 },
    );

    const parentVerifyDb = await openInitialized(dbPath);
    try {
      const stmt = parentVerifyDb.prepare(
        "SELECT job_id, target_thread_id, prompt, state, discord_message_id FROM codex_turn_queue WHERE job_id = ?",
      );
      stmt.setReadBigInts(true);
      const row1 = stmt.get(job1.jobId);
      assert.deepStrictEqual({ ...row1 }, {
        job_id: job1.jobId,
        target_thread_id: job1.targetThreadId,
        prompt: job1.prompt,
        state: "pending",
        discord_message_id: job1.discordMessageId,
      });
      const row2 = stmt.get(job2.jobId);
      assert.deepStrictEqual({ ...row2 }, {
        job_id: job2.jobId,
        target_thread_id: job2.targetThreadId,
        prompt: job2.prompt,
        state: "pending",
        discord_message_id: job2.discordMessageId,
      });
    } finally {
      parentVerifyDb.close();
    }
  } finally {
    const currentRealDir = resolve(realpathSync(fixtureDir));
    assert.strictEqual(currentRealDir.toLowerCase(), initialRealDir.toLowerCase());
    assert.strictEqual(dirname(currentRealDir).toLowerCase(), tmpRoot.toLowerCase());
    rmSync(initialRealDir, { recursive: true, force: true });
  }
});
