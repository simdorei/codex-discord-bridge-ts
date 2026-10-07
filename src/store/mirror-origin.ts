import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { openInitialized } from "./owned-driver.ts";
import type { QueueJobState, StoredQueueJob } from "./queue-read.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";

export type { QueueJobState, StoredQueueJob };

export function isWellFormedUnicode(value: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  for (const char of value) {
    const cp = char.codePointAt(0);
    if (cp !== undefined && cp >= 0xd800 && cp <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function getOwnDataProperty<T extends object, K extends keyof T & string>(
  obj: T,
  prop: K,
): unknown {
  if (obj === null || typeof obj !== "object" || types.isProxy(obj)) {
    throw new StoreIntegrityError("job must be a non-proxy object");
  }
  const desc = Object.getOwnPropertyDescriptor(obj, prop);
  if (!desc || !desc.enumerable || desc.get !== undefined || desc.set !== undefined || !("value" in desc)) {
    throw new StoreIntegrityError(`job.${prop} must be an own enumerable data property`);
  }
  if (desc.value !== null && typeof desc.value === "object" && types.isProxy(desc.value)) {
    throw new StoreIntegrityError(`job.${prop} must not be a proxy`);
  }
  return desc.value;
}

function rustTrim(input: string): string {
  return input.replace(/^[\p{White_Space}]+/u, "").replace(/[\p{White_Space}]+$/u, "");
}

export function userOriginMarker(thread: string, turn: string, prompt: string): string {
  if (typeof thread !== "string" || !isWellFormedUnicode(thread)) {
    throw new StoreIntegrityError("thread must be a well-formed string");
  }
  if (typeof turn !== "string" || !isWellFormedUnicode(turn)) {
    throw new StoreIntegrityError("turn must be a well-formed string");
  }
  if (typeof prompt !== "string" || !isWellFormedUnicode(prompt)) {
    throw new StoreIntegrityError("prompt must be a well-formed string");
  }
  const trimmed = rustTrim(prompt);
  const digest = createHash("sha256").update(trimmed, "utf8").digest("hex");
  return `discord-user:v1:${thread}:${turn}:${digest}`;
}

export function recordOrigin(
  db: DatabaseSync,
  thread: string,
  turn: string,
  prompt: string,
  now: number,
): void {
  if (typeof thread !== "string" || !isWellFormedUnicode(thread)) {
    throw new StoreIntegrityError("thread must be a well-formed string");
  }
  if (typeof turn !== "string" || !isWellFormedUnicode(turn)) {
    throw new StoreIntegrityError("turn must be a well-formed string");
  }
  if (typeof prompt !== "string" || !isWellFormedUnicode(prompt)) {
    throw new StoreIntegrityError("prompt must be a well-formed string");
  }
  if (typeof now !== "number") {
    throw new StoreIntegrityError("now must be a number");
  }
  const marker = userOriginMarker(thread, turn, prompt);
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO codex_session_mirror_events (event_digest, codex_thread_id, created_at) VALUES (?, ?, ?)",
  );
  stmt.run(marker, thread, now);
}

export { recordOrigin as record };

export function recordJobOrigin(db: DatabaseSync, job: StoredQueueJob): void {
  if (job === null || typeof job !== "object" || types.isProxy(job)) {
    throw new StoreIntegrityError("job must be a non-proxy object");
  }
  const turn = getOwnDataProperty(job, "turnId");
  if (turn === null || turn === undefined) {
    return;
  }
  const targetThreadId = getOwnDataProperty(job, "targetThreadId");
  const prompt = getOwnDataProperty(job, "prompt");
  const updatedAt = getOwnDataProperty(job, "updatedAt");
  recordOrigin(
    db,
    targetThreadId as string,
    turn as string,
    prompt as string,
    updatedAt as number,
  );
}

export async function recordUserOrigin(
  path: string,
  thread: string,
  turn: string,
  prompt: string,
  now: number,
): Promise<void> {
  if (typeof path !== "string" || !isWellFormedUnicode(path)) {
    throw new StoreIntegrityError("path must be a well-formed string");
  }
  if (typeof thread !== "string" || !isWellFormedUnicode(thread)) {
    throw new StoreIntegrityError("thread must be a well-formed string");
  }
  if (typeof turn !== "string" || !isWellFormedUnicode(turn)) {
    throw new StoreIntegrityError("turn must be a well-formed string");
  }
  if (typeof prompt !== "string" || !isWellFormedUnicode(prompt)) {
    throw new StoreIntegrityError("prompt must be a well-formed string");
  }
  if (typeof now !== "number") {
    throw new StoreIntegrityError("now must be a number");
  }
  const snapshotPath = path;
  const snapshotThread = thread;
  const snapshotTurn = turn;
  const snapshotPrompt = prompt;
  const snapshotNow = now;

  const db = await openInitialized(snapshotPath);
  try {
    recordOrigin(db, snapshotThread, snapshotTurn, snapshotPrompt, snapshotNow);
  } finally {
    db.close();
  }
}
