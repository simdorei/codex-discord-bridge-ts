import { Buffer } from "node:buffer";
import { InvalidAppServerManagedTargetError } from "./queue-managed-target.ts";
import {
  InvalidQueueStateError,
  isQuarantineEncoding,
  QUARANTINED_ERROR_PREFIX,
  QUARANTINED_TURN_PREFIX,
} from "./queue-read.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";

export {
  InvalidAppServerManagedTargetError,
  InvalidQueueStateError,
  isQuarantineEncoding,
  QUARANTINED_ERROR_PREFIX,
  QUARANTINED_TURN_PREFIX,
  StoreIntegrityError,
};

export const STARTING_CANDIDATE_HOLD_PREFIX =
  "[cdr-rust:turn-start-candidates-ambiguous:v1] ";

export interface RestartReadinessSnapshot {
  readonly targetThreadIds: readonly string[];
  readonly blockers: readonly string[];
  readonly observations: readonly string[];
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

export function rustTrim(s: string): string {
  let start = 0;
  while (start < s.length && isRustWhitespace(s.charCodeAt(start))) {
    start++;
  }
  let end = s.length;
  while (end > start && isRustWhitespace(s.charCodeAt(end - 1))) {
    end--;
  }
  return s.slice(start, end);
}

export function validateTarget(target: string): void {
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    rustTrim(target) !== target
  ) {
    throw new InvalidAppServerManagedTargetError(String(target));
  }
}

export const validate_target = validateTarget;

export function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}

function isReadonlyArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function snapshotEquals(
  a: RestartReadinessSnapshot,
  b: RestartReadinessSnapshot,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    arraysEqual(a.targetThreadIds, b.targetThreadIds) &&
    arraysEqual(a.blockers, b.blockers) &&
    arraysEqual(a.observations, b.observations)
  );
}

export const snapshot_equals = snapshotEquals;

export type MirrorThreadRow =
  | string
  | readonly [codexThreadId: string, ...unknown[]]
  | {
      readonly codex_thread_id?: string;
      readonly codexThreadId?: string;
    };

export type TurnQueueRow =
  | readonly [
      jobId: string,
      targetThreadId: string,
      state: string,
      turnId: string | null,
      lastError: string,
      ...unknown[],
    ]
  | {
      readonly job_id?: string;
      readonly jobId?: string;
      readonly target_thread_id?: string;
      readonly targetThreadId?: string;
      readonly state: string;
      readonly turn_id?: string | null;
      readonly turnId?: string | null;
      readonly last_error?: string;
      readonly lastError?: string;
    };

export type PromptIntakeRow =
  | readonly [
      jobId: string,
      targetThreadId: string,
      claimToken: string | null,
      ...unknown[],
    ]
  | {
      readonly job_id?: string;
      readonly jobId?: string;
      readonly target_thread_id?: string;
      readonly targetThreadId?: string;
      readonly claim_token?: string | null;
      readonly claimToken?: string | null;
    };

export type AppServerManagedTargetRow =
  | string
  | readonly [threadId: string, ...unknown[]]
  | {
      readonly thread_id?: string;
      readonly threadId?: string;
    };

export type ThreadForkHandoffRow =
  | readonly [
      handoffId: string,
      sourceThreadId: string,
      observedTargetThreadId: string | null,
      targetThreadId: string | null,
      ...unknown[],
    ]
  | {
      readonly handoff_id?: string;
      readonly handoffId?: string;
      readonly source_thread_id?: string;
      readonly sourceThreadId?: string;
      readonly observed_target_thread_id?: string | null;
      readonly observedTargetThreadId?: string | null;
      readonly target_thread_id?: string | null;
      readonly targetThreadId?: string | null;
    };

/**
 * In-memory decoded row representations for pure restart readiness evaluation.
 *
 * Scope: Decoded-compatible well-formed string/null inputs only; does not claim raw
 * SQLite byte decoding, lone surrogate preservation, or database I/O.
 * Optional undefined object convenience fields are ergonomic outside strict decoder parity
 * and do not constitute proof of raw database decoding.
 */
export interface RestartSnapshotPureInput {
  readonly mirrorThreads?: readonly MirrorThreadRow[] | null;
  readonly mirror_threads?: readonly MirrorThreadRow[] | null;
  readonly turnQueue?: readonly TurnQueueRow[] | null;
  readonly codex_turn_queue?: readonly TurnQueueRow[] | null;
  readonly promptIntakes?: readonly PromptIntakeRow[] | null;
  readonly codex_prompt_intakes?: readonly PromptIntakeRow[] | null;
  readonly appServerManagedTargets?: readonly AppServerManagedTargetRow[] | null;
  readonly codex_app_server_managed_targets?: readonly AppServerManagedTargetRow[] | null;
  readonly threadForkHandoffs?: readonly ThreadForkHandoffRow[] | null;
  readonly codex_thread_fork_handoffs?: readonly ThreadForkHandoffRow[] | null;
}

/**
 * Pure evaluation of restart readiness from decoded-compatible well-formed string/null inputs.
 *
 * Explicitly operates without raw SQLite, lone surrogate, or database I/O claims.
 * Optional/undefined object convenience representations exist outside strict decoder parity
 * and do not claim raw decoder proof.
 */
export function computeRestartSnapshotPure(
  input: RestartSnapshotPureInput,
): RestartReadinessSnapshot {
  const targets = new Set<string>();
  const blockers: string[] = [];
  const observations: string[] = [];

  const mirrorRows = input.mirrorThreads ?? input.mirror_threads ?? [];
  for (const row of mirrorRows) {
    let target: string;
    if (typeof row === "string") {
      target = row;
    } else if (isReadonlyArray(row)) {
      if (typeof row[0] !== "string") {
        throw new StoreIntegrityError(
          "mirror_threads codex_thread_id must be a string",
        );
      }
      target = row[0];
    } else if (row && typeof row === "object") {
      const val = row.codex_thread_id ?? row.codexThreadId;
      if (typeof val !== "string") {
        throw new StoreIntegrityError(
          "mirror_threads codex_thread_id must be a string",
        );
      }
      target = val;
    } else {
      throw new StoreIntegrityError("Invalid mirror_threads row");
    }
    validateTarget(target);
    targets.add(target);
  }

  const queueRows = input.turnQueue ?? input.codex_turn_queue ?? [];
  for (const row of queueRows) {
    let jobId: string;
    let targetThreadId: string;
    let state: string;
    let turnId: string | null;
    let lastError: string;

    if (isReadonlyArray(row)) {
      const [j, t, s, tu, l] = row;
      if (typeof j !== "string") {
        throw new StoreIntegrityError(
          "codex_turn_queue job_id must be a string",
        );
      }
      if (typeof t !== "string") {
        throw new StoreIntegrityError(
          "codex_turn_queue target_thread_id must be a string",
        );
      }
      if (typeof s !== "string") {
        throw new StoreIntegrityError(
          "codex_turn_queue state must be a string",
        );
      }
      if (tu !== null && tu !== undefined && typeof tu !== "string") {
        throw new StoreIntegrityError(
          "codex_turn_queue turn_id must be a string or null",
        );
      }
      if (typeof l !== "string") {
        throw new StoreIntegrityError(
          "codex_turn_queue last_error must be a string",
        );
      }
      jobId = j;
      targetThreadId = t;
      state = s;
      turnId = tu ?? null;
      lastError = l;
    } else if (row && typeof row === "object") {
      const j = row.job_id ?? row.jobId;
      const t = row.target_thread_id ?? row.targetThreadId;
      const s = row.state;
      const tu = row.turn_id !== undefined ? row.turn_id : row.turnId;
      const l = row.last_error ?? row.lastError;
      if (typeof j !== "string") {
        throw new StoreIntegrityError(
          "codex_turn_queue job_id must be a string",
        );
      }
      if (typeof t !== "string") {
        throw new StoreIntegrityError(
          "codex_turn_queue target_thread_id must be a string",
        );
      }
      if (typeof s !== "string") {
        throw new StoreIntegrityError(
          "codex_turn_queue state must be a string",
        );
      }
      if (tu !== null && tu !== undefined && typeof tu !== "string") {
        throw new StoreIntegrityError(
          "codex_turn_queue turn_id must be a string or null",
        );
      }
      if (typeof l !== "string") {
        throw new StoreIntegrityError(
          "codex_turn_queue last_error must be a string",
        );
      }
      jobId = j;
      targetThreadId = t;
      state = s;
      turnId = tu ?? null;
      lastError = l;
    } else {
      throw new StoreIntegrityError("Invalid codex_turn_queue row");
    }

    validateTarget(targetThreadId);
    targets.add(targetThreadId);

    let semantic: string;
    if (state === "pending") {
      semantic = "pending";
    } else if (state === "starting") {
      if (lastError.startsWith(STARTING_CANDIDATE_HOLD_PREFIX)) {
        semantic = "starting_hold";
      } else {
        blockers.push(`queue job ${jobId} is ${state}`);
        semantic = "starting";
      }
    } else if (state === "running") {
      if (isQuarantineEncoding(state, turnId, lastError)) {
        semantic = "quarantined";
      } else {
        blockers.push(`queue job ${jobId} is ${state}`);
        semantic = "running";
      }
    } else {
      throw new InvalidQueueStateError(state);
    }
    observations.push(`queue:${jobId}:${targetThreadId}:${semantic}`);
  }

  const intakeRows =
    input.promptIntakes !== undefined
      ? input.promptIntakes
      : input.codex_prompt_intakes;
  if (intakeRows !== null && intakeRows !== undefined) {
    for (const row of intakeRows) {
      let jobId: string;
      let targetThreadId: string;
      let claimToken: string | null;

      if (isReadonlyArray(row)) {
        const [j, t, c] = row;
        if (typeof j !== "string") {
          throw new StoreIntegrityError(
            "codex_prompt_intakes job_id must be a string",
          );
        }
        if (typeof t !== "string") {
          throw new StoreIntegrityError(
            "codex_prompt_intakes target_thread_id must be a string",
          );
        }
        if (c !== null && c !== undefined && typeof c !== "string") {
          throw new StoreIntegrityError(
            "codex_prompt_intakes claim_token must be a string or null",
          );
        }
        jobId = j;
        targetThreadId = t;
        claimToken = c ?? null;
      } else if (row && typeof row === "object") {
        const j = row.job_id ?? row.jobId;
        const t = row.target_thread_id ?? row.targetThreadId;
        const c =
          row.claim_token !== undefined ? row.claim_token : row.claimToken;
        if (typeof j !== "string") {
          throw new StoreIntegrityError(
            "codex_prompt_intakes job_id must be a string",
          );
        }
        if (typeof t !== "string") {
          throw new StoreIntegrityError(
            "codex_prompt_intakes target_thread_id must be a string",
          );
        }
        if (c !== null && c !== undefined && typeof c !== "string") {
          throw new StoreIntegrityError(
            "codex_prompt_intakes claim_token must be a string or null",
          );
        }
        jobId = j;
        targetThreadId = t;
        claimToken = c ?? null;
      } else {
        throw new StoreIntegrityError("Invalid codex_prompt_intakes row");
      }

      validateTarget(targetThreadId);
      targets.add(targetThreadId);

      const claimed = claimToken !== null;
      if (claimed) {
        blockers.push(`prompt intake ${jobId} is claimed`);
      }
      observations.push(`intake:${jobId}:${targetThreadId}:claimed=${claimed}`);
    }
  }

  const managedRows =
    input.appServerManagedTargets !== undefined
      ? input.appServerManagedTargets
      : input.codex_app_server_managed_targets;
  if (managedRows !== null && managedRows !== undefined) {
    for (const row of managedRows) {
      let target: string;
      if (typeof row === "string") {
        target = row;
      } else if (isReadonlyArray(row)) {
        if (typeof row[0] !== "string") {
          throw new StoreIntegrityError(
            "codex_app_server_managed_targets thread_id must be a string",
          );
        }
        target = row[0];
      } else if (row && typeof row === "object") {
        const val = row.thread_id ?? row.threadId;
        if (typeof val !== "string") {
          throw new StoreIntegrityError(
            "codex_app_server_managed_targets thread_id must be a string",
          );
        }
        target = val;
      } else {
        throw new StoreIntegrityError(
          "Invalid codex_app_server_managed_targets row",
        );
      }
      validateTarget(target);
      targets.add(target);
    }
  }

  const forkRows =
    input.threadForkHandoffs !== undefined
      ? input.threadForkHandoffs
      : input.codex_thread_fork_handoffs;
  if (forkRows !== null && forkRows !== undefined) {
    for (const row of forkRows) {
      let handoffId: string;
      let sourceThreadId: string;
      let observedTargetThreadId: string | null;
      let targetThreadId: string | null;

      if (isReadonlyArray(row)) {
        const [h, s, o, t] = row;
        if (typeof h !== "string") {
          throw new StoreIntegrityError(
            "codex_thread_fork_handoffs handoff_id must be a string",
          );
        }
        if (typeof s !== "string") {
          throw new StoreIntegrityError(
            "codex_thread_fork_handoffs source_thread_id must be a string",
          );
        }
        if (o !== null && o !== undefined && typeof o !== "string") {
          throw new StoreIntegrityError(
            "codex_thread_fork_handoffs observed_target_thread_id must be a string or null",
          );
        }
        if (t !== null && t !== undefined && typeof t !== "string") {
          throw new StoreIntegrityError(
            "codex_thread_fork_handoffs target_thread_id must be a string or null",
          );
        }
        handoffId = h;
        sourceThreadId = s;
        observedTargetThreadId = o ?? null;
        targetThreadId = t ?? null;
      } else if (row && typeof row === "object") {
        const h = row.handoff_id ?? row.handoffId;
        const s = row.source_thread_id ?? row.sourceThreadId;
        const o =
          row.observed_target_thread_id !== undefined
            ? row.observed_target_thread_id
            : row.observedTargetThreadId;
        const t =
          row.target_thread_id !== undefined
            ? row.target_thread_id
            : row.targetThreadId;
        if (typeof h !== "string") {
          throw new StoreIntegrityError(
            "codex_thread_fork_handoffs handoff_id must be a string",
          );
        }
        if (typeof s !== "string") {
          throw new StoreIntegrityError(
            "codex_thread_fork_handoffs source_thread_id must be a string",
          );
        }
        if (o !== null && o !== undefined && typeof o !== "string") {
          throw new StoreIntegrityError(
            "codex_thread_fork_handoffs observed_target_thread_id must be a string or null",
          );
        }
        if (t !== null && t !== undefined && typeof t !== "string") {
          throw new StoreIntegrityError(
            "codex_thread_fork_handoffs target_thread_id must be a string or null",
          );
        }
        handoffId = h;
        sourceThreadId = s;
        observedTargetThreadId = o ?? null;
        targetThreadId = t ?? null;
      } else {
        throw new StoreIntegrityError(
          "Invalid codex_thread_fork_handoffs row",
        );
      }

      validateTarget(sourceThreadId);
      targets.add(sourceThreadId);

      if (observedTargetThreadId !== null) {
        validateTarget(observedTargetThreadId);
        targets.add(observedTargetThreadId);
      }

      if (targetThreadId !== null) {
        validateTarget(targetThreadId);
        targets.add(targetThreadId);
      }

      const obsStr =
        observedTargetThreadId !== null ? observedTargetThreadId : "none";
      const tgtStr = targetThreadId !== null ? targetThreadId : "none";
      observations.push(
        `fork:${handoffId}:${sourceThreadId}:observed=${obsStr}:target=${tgtStr}`,
      );
    }
  }

  blockers.sort(compareUtf8Bytes);
  observations.sort(compareUtf8Bytes);
  const targetThreadIds = Array.from(targets).sort(compareUtf8Bytes);

  return {
    targetThreadIds,
    blockers,
    observations,
  };
}

export const restartSnapshotPure = computeRestartSnapshotPure;
export const takeRestartSnapshotPure = computeRestartSnapshotPure;
export const snapshotPure = computeRestartSnapshotPure;
export const computeRestartReadinessSnapshot = computeRestartSnapshotPure;
