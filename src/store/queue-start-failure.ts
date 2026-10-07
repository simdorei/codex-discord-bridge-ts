import { I64_MAX, I64_MIN } from "../protocol/ids.ts";
import { jobCanMutate } from "./dead-generation-admission.ts";
import { openInitialized } from "./owned-driver.ts";
import {
  QueueJobNotFoundError,
  type StoredQueueJob,
  selectJob,
} from "./queue-read.ts";

export class DeadGenerationTargetHeldError extends Error {
  readonly kind = "DeadGenerationTargetHeld" as const;
  readonly targetThreadId: string;

  constructor(targetThreadId: string) {
    super(
      `conversation ${targetThreadId} is on hold after app-server process loss; manual review is required`,
    );
    this.name = "DeadGenerationTargetHeldError";
    this.targetThreadId = targetThreadId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SystemTimeError extends Error {
  readonly kind = "SystemTime" as const;

  constructor(
    message = "system clock is before the Unix epoch: second time provided was later than self",
  ) {
    const prefix = "system clock is before the Unix epoch: ";
    const fullMessage = message.startsWith(prefix) ? message : `${prefix}${message}`;
    super(fullMessage);
    this.name = "SystemTimeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export { QueueJobNotFoundError };

function isWellFormedUnicode(s: string): boolean {
  if (typeof s !== "string") {
    return false;
  }
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= s.length) return false;
      const next = s.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isRustWhitespace(code: number): boolean {
  return (
    (code >= 0x0009 && code <= 0x000d) ||
    code === 0x0020 ||
    code === 0x0085 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

function rustTrimAndBound(error: string): string {
  const codePoints: number[] = [];
  for (const ch of error) {
    codePoints.push(ch.codePointAt(0)!);
  }
  let start = 0;
  while (start < codePoints.length && isRustWhitespace(codePoints[start]!)) {
    start++;
  }
  let end = codePoints.length;
  while (end > start && isRustWhitespace(codePoints[end - 1]!)) {
    end--;
  }
  const takeCount = Math.min(1000, end - start);
  if (takeCount <= 0) {
    return "";
  }
  const taken = codePoints.slice(start, start + takeCount);
  let result = "";
  for (let i = 0; i < taken.length; i += 500) {
    result += String.fromCodePoint(...taken.slice(i, i + 500));
  }
  return result;
}

function getNowSeconds(): number {
  const nowMs = Date.now();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("system clock must be finite");
  }
  if (nowMs < 0) {
    throw new SystemTimeError(
      "system clock is before the Unix epoch: second time provided was later than self",
    );
  }
  return nowMs / 1000;
}

export async function recordStartFailure(
  path: string,
  jobId: string,
  generation: bigint,
  error: string,
  ambiguous: boolean,
): Promise<StoredQueueJob> {
  if (typeof path !== "string" || !isWellFormedUnicode(path)) {
    throw new TypeError("Invalid path: expected well-formed string");
  }
  if (typeof jobId !== "string" || !isWellFormedUnicode(jobId)) {
    throw new TypeError("Invalid jobId: expected well-formed string");
  }
  if (typeof generation !== "bigint") {
    throw new TypeError("Invalid generation: expected bigint");
  }
  if (generation < I64_MIN || generation > I64_MAX) {
    throw new RangeError(
      `Generation out of signed i64 range: ${generation.toString()}`,
    );
  }
  if (typeof error !== "string" || !isWellFormedUnicode(error)) {
    throw new TypeError("Invalid error: expected well-formed string");
  }
  if (typeof ambiguous !== "boolean") {
    throw new TypeError("Invalid ambiguous: expected boolean");
  }

  const targetPath = path;
  const targetJobId = jobId;
  const targetGeneration = generation;
  const targetError = error;
  const targetAmbiguous = ambiguous;

  const db = await openInitialized(targetPath);
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE;");
    const original = selectJob(db, targetJobId);
    if (!jobCanMutate(db, original)) {
      throw new DeadGenerationTargetHeldError(original.targetThreadId);
    }
    const boundedError = rustTrimAndBound(targetError);
    const state = targetAmbiguous ? "starting" : "pending";
    const nowSec = getNowSeconds();

    const stmt = db.prepare(
      "UPDATE codex_turn_queue SET state = ?, last_error = ?, updated_at = ? WHERE job_id = ? AND app_server_generation = ?",
    );
    const result = stmt.run(
      state,
      boundedError,
      nowSec,
      targetJobId,
      targetGeneration,
    );
    if (Number(result.changes) !== 1) {
      throw new QueueJobNotFoundError(targetJobId);
    }
    const updated = selectJob(db, targetJobId);
    db.exec("COMMIT;");
    committed = true;
    return updated;
  } finally {
    if (!committed) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // preserve primary error on rollback failure
      }
    }
    try {
      db.close();
    } catch {
      // preserve primary error on close failure
    }
  }
}
