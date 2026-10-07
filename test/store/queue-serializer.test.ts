import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSerdeValue } from "../../src/core/serde-json-parse.ts";
import { serializeStoredQueueJob, type StoredQueueJob } from "../../src/store/queue-read.ts";

interface FixtureRow {
  input: string;
  createdBits: string;
  updatedBits: string;
  serialized: string;
}

interface FixtureJob {
  job_id: string;
  target_thread_id: string;
  channel_id: bigint;
  owner_user_id: bigint | null;
  discord_message_id: bigint | null;
  app_server_generation: bigint;
  execution_generation: bigint | null;
  turn_observation_generation: bigint | null;
  goal_waiting: boolean;
  prompt: string;
  queued: boolean;
  ack_sent: boolean;
  state: StoredQueueJob["state"];
  attempt_count: bigint;
  turn_id: string | null;
  baseline_turn_ids: string[];
  last_error: string;
  created_at: number;
  updated_at: number;
}

interface FixtureInput {
  job: FixtureJob;
  created_bits: string;
  updated_bits: string;
}

const dv = new DataView(new ArrayBuffer(8));
function bitsToFloat(hex: string): number {
  dv.setBigUint64(0, BigInt(`0x${hex}`));
  return dv.getFloat64(0);
}

function toStoredQueueJob(inputStr: string, createdBits: string, updatedBits: string): StoredQueueJob {
  const parsed = parseSerdeValue<FixtureInput>(inputStr);
  const j = parsed.job;
  return {
    jobId: j.job_id,
    targetThreadId: j.target_thread_id,
    channelId: j.channel_id,
    ownerUserId: j.owner_user_id,
    discordMessageId: j.discord_message_id,
    appServerGeneration: j.app_server_generation,
    executionGeneration: j.execution_generation,
    turnObservationGeneration: j.turn_observation_generation,
    goalWaiting: j.goal_waiting,
    prompt: j.prompt,
    queued: j.queued,
    ackSent: j.ack_sent,
    state: j.state,
    attemptCount: j.attempt_count,
    turnId: j.turn_id,
    baselineTurnIds: [...j.baseline_turn_ids],
    lastError: j.last_error,
    createdAt: bitsToFloat(createdBits),
    updatedAt: bitsToFloat(updatedBits),
  };
}

const fixtureUrl = new URL("../fixtures/queue-job-serde-goldens.ndjson", import.meta.url);
const fixtureRows: FixtureRow[] = readFileSync(fixtureUrl, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as FixtureRow);

function getValidJob(): StoredQueueJob {
  const row = fixtureRows[0];
  assert.ok(row !== undefined);
  return toStoredQueueJob(row.input, row.createdBits, row.updatedBits);
}

describe("queue serializer", () => {
  it("serializes all 16 Rust golden fixtures matching exact wire serialized output", () => {
    assert.equal(fixtureRows.length, 16);
    for (let i = 0; i < fixtureRows.length; i++) {
      const row = fixtureRows[i];
      assert.ok(row !== undefined);
      const job = toStoredQueueJob(row.input, row.createdBits, row.updatedBits);
      assert.equal(serializeStoredQueueJob(job), row.serialized, `Row ${i} mismatch`);
    }
  });

  it("rejects Proxy job without calling traps", () => {
    const traps = { get: 0, ownKeys: 0, getPrototypeOf: 0, getOwnPropertyDescriptor: 0 };
    const proxy = new Proxy(getValidJob(), {
      get(t, p, r) { traps.get++; return Reflect.get(t, p, r); },
      ownKeys(t) { traps.ownKeys++; return Reflect.ownKeys(t); },
      getPrototypeOf(t) { traps.getPrototypeOf++; return Reflect.getPrototypeOf(t); },
      getOwnPropertyDescriptor(t, p) { traps.getOwnPropertyDescriptor++; return Reflect.getOwnPropertyDescriptor(t, p); },
    });
    assert.throws(() => serializeStoredQueueJob(proxy), TypeError);
    assert.deepEqual(traps, { get: 0, ownKeys: 0, getPrototypeOf: 0, getOwnPropertyDescriptor: 0 });
  });

  it("rejects Proxy baselineTurnIds without calling traps", () => {
    const traps = { get: 0, ownKeys: 0, getPrototypeOf: 0, getOwnPropertyDescriptor: 0 };
    const baseProxy = new Proxy(["t1"], {
      get(t, p, r) { traps.get++; return Reflect.get(t, p, r); },
      ownKeys(t) { traps.ownKeys++; return Reflect.ownKeys(t); },
      getPrototypeOf(t) { traps.getPrototypeOf++; return Reflect.getPrototypeOf(t); },
      getOwnPropertyDescriptor(t, p) { traps.getOwnPropertyDescriptor++; return Reflect.getOwnPropertyDescriptor(t, p); },
    });
    assert.throws(() => serializeStoredQueueJob({ ...getValidJob(), baselineTurnIds: baseProxy }), TypeError);
    assert.deepEqual(traps, { get: 0, ownKeys: 0, getPrototypeOf: 0, getOwnPropertyDescriptor: 0 });
  });

  it("rejects getters with zero calls", () => {
    let calls = 0;
    const job = getValidJob();
    Object.defineProperty(job, "prompt", {
      get() { calls++; return "p"; },
      enumerable: true,
      configurable: true,
    });
    assert.throws(() => serializeStoredQueueJob(job), TypeError);
    assert.equal(calls, 0);
  });

  it("accepts baseline array subclass without calling inherited toJSON", () => {
    let toJSONCalls = 0;
    class SubTurns extends Array<string> {
      toJSON() {
        toJSONCalls++;
        return ["corrupted"];
      }
    }
    const sub = new SubTurns("t1", "t2");
    const serialized = serializeStoredQueueJob({ ...getValidJob(), baselineTurnIds: sub });
    assert.equal(toJSONCalls, 0);
    assert.match(serialized, /"baseline_turn_ids":\["t1","t2"\]/);
  });

  it("rejects sparse baseline array and non-string elements", () => {
    const sparse = ["a", "b"];
    delete (sparse as Record<number, string>)[0];
    assert.throws(() => serializeStoredQueueJob({ ...getValidJob(), baselineTurnIds: sparse }), TypeError);

    const nonString = ["a", 42 as unknown as string];
    assert.throws(() => serializeStoredQueueJob({ ...getValidJob(), baselineTurnIds: nonString }), TypeError);
  });

  it("rejects malformed UTF-16 in job strings", () => {
    assert.throws(() => serializeStoredQueueJob({ ...getValidJob(), prompt: String.fromCharCode(0xd800) }), TypeError);
  });

  it("rejects bigint channelId overflow", () => {
    assert.throws(() => serializeStoredQueueJob({ ...getValidJob(), channelId: 9223372036854775808n }), RangeError);
  });

  it("rejects invalid boolean field and non-plain class instances", () => {
    assert.throws(() => serializeStoredQueueJob({ ...getValidJob(), queued: "true" as unknown as boolean }), TypeError);

    class CustomJob {}
    const classJob = Object.assign(new CustomJob(), getValidJob());
    assert.throws(() => serializeStoredQueueJob(classJob as unknown as StoredQueueJob), TypeError);
  });

  it("serializes non-finite timestamps as null", () => {
    const serialized = serializeStoredQueueJob({
      ...getValidJob(),
      createdAt: Number.NaN,
      updatedAt: Number.POSITIVE_INFINITY,
    });
    assert.match(serialized, /"created_at":null/);
    assert.match(serialized, /"updated_at":null/);
  });

  it("rejects string timestamp", () => {
    assert.throws(() => serializeStoredQueueJob({ ...getValidJob(), createdAt: "0" as unknown as number }), TypeError);
  });

  it("does not mutate caller array and accepts frozen array", () => {
    const frozen = Object.freeze(["f1", "f2"]);
    const serialized = serializeStoredQueueJob({
      ...getValidJob(),
      baselineTurnIds: frozen as unknown as string[],
    });
    assert.equal(frozen.length, 2);
    assert.equal(frozen[0], "f1");
    assert.match(serialized, /"baseline_turn_ids":\["f1","f2"\]/);
  });
});
