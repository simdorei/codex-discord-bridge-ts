import assert from "node:assert/strict";
import { test } from "node:test";
import { QueueReadCoordinator } from "../../../src/runtime/queue-runner/read-coordinator.ts";
import { queueJob } from "../../helpers/queue-job.ts";
import type { StoredQueueJob } from "../../../src/store/queue-read.ts";

test("busy reads preserve backend/list/hold order even when a turn is active", async () => {
  const calls: string[] = [];
  const queue = new QueueReadCoordinator("db", {activeTurnId: async target => {
    calls.push(`backend:${target}`); return "";
  }}, {
    listFiltered: async (path, target, generation) => {
      assert.equal(path, "db"); assert.equal(target, "t"); assert.equal(generation, null);
      calls.push("list"); return [];
    },
    eligibleJobs: async () => { calls.push("holds"); return []; },
  });
  assert.deepEqual(await queue.busyStatus("t"), {busy: true, allowSteer: true});
  assert.deepEqual(calls, ["backend:t", "list", "holds"]);
  assert.equal(queue.locks.activeTargetCount, 0);
});

test("queued eligible work is busy without steer; quarantined-only work is not", async () => {
  let eligible = [queueJob()];
  const queue = new QueueReadCoordinator("db", {activeTurnId: async () => null}, {
    listFiltered: async () => eligible,
    eligibleJobs: async () => eligible,
  });
  assert.deepEqual(await queue.busyStatus("t"), {busy: true, allowSteer: false});
  eligible = [queueJob({state: "Quarantined"})];
  assert.deepEqual(await queue.busyStatus("t"), {busy: false, allowSteer: false});
  eligible = [];
  assert.deepEqual(await queue.busyStatus("t"), {busy: false, allowSteer: false});
});

test("same-target busy calls share the lease; unrelated target progresses", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const queue = new QueueReadCoordinator("db", {activeTurnId: async target => {
    calls.push(target); if (target === "blocked") await gate; return null;
  }}, {listFiltered: async () => [], eligibleJobs: async () => []});
  const first = queue.busyStatus("blocked"); const second = queue.busyStatus("blocked");
  await queue.busyStatus("other");
  assert.deepEqual(calls, ["blocked", "other"]);
  assert.equal(queue.locks.tryAcquire("blocked"), undefined);
  release(); await Promise.all([first, second]);
  assert.deepEqual(calls, ["blocked", "other", "blocked"]);
  assert.equal(queue.locks.activeTargetCount, 0);
});

test("backend and storage errors retain identity and release the target", async () => {
  const error = new Error("sentinel");
  for (const stage of ["backend", "list", "holds"]) {
    const queue = new QueueReadCoordinator("db", {activeTurnId: async () => {
      if (stage === "backend") throw error; return "active";
    }}, {
      listFiltered: async () => { if (stage === "list") throw error; return []; },
      eligibleJobs: async () => { throw error; },
    });
    await assert.rejects(queue.busyStatus("t"), value => value === error);
    assert.equal(queue.locks.activeTargetCount, 0);
  }
});

test("control binding active turn skips storage, including an empty turn ID", async () => {
  const queue = new QueueReadCoordinator("db", {activeTurnId: async () => ""}, {
    listFiltered: async () => { throw new Error("unexpected list"); },
    eligibleJobs: async () => { throw new Error("unexpected hold filtering"); },
  });
  assert.deepEqual(await queue.controlBinding("t"), ["", null]);
});

test("control binding needs exactly one Starting/Running non-goal-waiting job", async () => {
  let jobs: StoredQueueJob[] = [];
  const queue = new QueueReadCoordinator("db", {activeTurnId: async () => null}, {
    listFiltered: async () => jobs,
    eligibleJobs: async () => { throw new Error("control binding must not filter holds"); },
  });
  assert.deepEqual(await queue.controlBinding("t"), [null, null]);
  jobs = [queueJob({state: "Starting", jobId: "start"}), queueJob({state: "Running", goalWaiting: true})];
  assert.deepEqual(await queue.controlBinding("t"), [null, "start"]);
  jobs.push(queueJob({state: "Running", turnId: "turn"}));
  assert.deepEqual(await queue.controlBinding("t"), [null, null]);
  jobs = [queueJob({state: "Running", turnId: "turn"}), queueJob({state: "Pending"}), queueJob({state: "Quarantined"})];
  assert.deepEqual(await queue.controlBinding("t"), ["turn", "saved"]);
});
