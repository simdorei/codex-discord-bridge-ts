import type { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { I64_MIN, I64_MAX } from "../protocol/ids.ts";
import type { QueueJobState, StoredQueueJob } from "./queue-read.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";

export type { QueueJobState, StoredQueueJob };

export const DOMAIN = "reserve/start-failure/v1";
export const EXECUTION_HOLD_PREFIX = "[cdr-rust:execution-held:v1] ";
export const HOLD_PREFIX = "[cdr-rust:auto-reserve-hold:v1] ";
export const AUTO_RESERVE_HOLD_PREFIX = HOLD_PREFIX;

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

function stripNoticePrefix(reason: string): string {
  if (reason.startsWith(EXECUTION_HOLD_PREFIX)) {
    return reason.slice(EXECUTION_HOLD_PREFIX.length);
  }
  if (reason.startsWith(HOLD_PREFIX)) {
    return reason.slice(HOLD_PREFIX.length);
  }
  return reason;
}

function takeUnicodeScalars(str: string, maxScalars: number): string {
  let result = "";
  let count = 0;
  for (const scalar of str) {
    if (count >= maxScalars) {
      break;
    }
    result += scalar;
    count++;
  }
  return result;
}

export function stageStartNoticeIn(
  db: DatabaseSync,
  job: StoredQueueJob,
  reason: string,
): void {
  if (job === null || typeof job !== "object" || types.isProxy(job)) {
    throw new StoreIntegrityError("job must be a non-proxy object");
  }

  const jobId = getOwnDataProperty(job, "jobId");
  const targetThreadId = getOwnDataProperty(job, "targetThreadId");
  const channelId = getOwnDataProperty(job, "channelId");
  const appServerGeneration = getOwnDataProperty(job, "appServerGeneration");
  const attemptCount = getOwnDataProperty(job, "attemptCount");

  if (typeof jobId !== "string" || !isWellFormedUnicode(jobId)) {
    throw new StoreIntegrityError("job.jobId must be a well-formed string");
  }
  if (typeof targetThreadId !== "string" || !isWellFormedUnicode(targetThreadId)) {
    throw new StoreIntegrityError("job.targetThreadId must be a well-formed string");
  }
  if (typeof channelId !== "bigint" || channelId < I64_MIN || channelId > I64_MAX) {
    throw new StoreIntegrityError("job.channelId must be a signed 64-bit bigint");
  }
  if (
    typeof appServerGeneration !== "bigint" ||
    appServerGeneration < I64_MIN ||
    appServerGeneration > I64_MAX
  ) {
    throw new StoreIntegrityError("job.appServerGeneration must be a signed 64-bit bigint");
  }
  if (
    typeof attemptCount !== "bigint" ||
    attemptCount < I64_MIN ||
    attemptCount > I64_MAX
  ) {
    throw new StoreIntegrityError("job.attemptCount must be a signed 64-bit bigint");
  }
  if (typeof reason !== "string" || !isWellFormedUnicode(reason)) {
    throw new StoreIntegrityError("reason must be a well-formed string");
  }

  const strippedReason = stripNoticePrefix(reason);
  const truncatedReason = takeUnicodeScalars(strippedReason, 700);
  const content = `Failed\n사용량 한도로 요청 시작이 거절됐습니다.\njob: ${jobId}\n${truncatedReason}\n이 요청은 자동 재실행하지 않습니다. 필요하면 모델을 수동으로 변경한 뒤 새 요청을 보내세요.`;

  const stmt = db.prepare(
    "INSERT OR IGNORE INTO codex_reserve_start_notices (job_id,target_thread_id,channel_id,app_server_generation,attempt_count,content) VALUES(?1,?2,?3,?4,?5,?6)",
  );
  stmt.run(
    jobId,
    targetThreadId,
    channelId,
    appServerGeneration,
    attemptCount,
    content,
  );
}

export { stageStartNoticeIn as stageIn };
