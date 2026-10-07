import type { DatabaseSync } from "node:sqlite";
import type { StoredQueueJob } from "./queue-read.ts";
import { getIn } from "./new-reply-read.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";

const BIND_RUNNING_SQL =
  "UPDATE codex_new_first_replies SET turn_id = ?, accepted_at = ?, version = version + 1 WHERE job_id = ? AND turn_id IS NULL";

function assertWellFormedUnicode(val: string, field: string): void {
  for (const ch of val) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && cp >= 0xd800 && cp <= 0xdfff) {
      throw new StoreIntegrityError(`malformed Unicode scalar in ${field}`);
    }
  }
}

export function bindRunningIn(db: DatabaseSync, job: StoredQueueJob): void {
  if (job.state !== "Running") {
    return;
  }

  const record = getIn(db, job.jobId);
  if (record === null) {
    return;
  }

  if (job.turnId === null) {
    return;
  }

  if (
    record.identity.thread_id !== job.targetThreadId ||
    record.identity.channel_id !== job.channelId
  )
  {
    throw new StoreIntegrityError(
      "new first-turn binding changed its destination",
    );
  }

  if (record.turnId !== null) {
    return;
  }

  assertWellFormedUnicode(job.turnId, "turnId");

  const stmt = db.prepare(BIND_RUNNING_SQL);
  stmt.run(job.turnId, job.updatedAt, job.jobId);
}
