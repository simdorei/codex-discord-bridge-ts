import { types } from "node:util";
import { parseSerdeValue } from "../core/serde-json-parse.ts";
import { rustDebugString } from "../core/rust-debug.ts";
import { U64_MAX } from "../protocol/ids.ts";

export type RestartReadinessState =
  | { status: "Ready" }
  | { status: "Blocked"; reason: string };

export class InvalidThreadStateError extends Error {
  readonly threadId: string;
  readonly thread_id: string;
  readonly reason: string;

  constructor(threadId: string, reason: string) {
    super(`invalid app-server thread state for ${threadId}: ${reason}`);
    this.name = "InvalidThreadStateError";
    this.threadId = threadId;
    this.thread_id = threadId;
    this.reason = reason;
    Object.setPrototypeOf(this, InvalidThreadStateError.prototype);
  }
}

export class InvalidClassifierArgumentError extends TypeError {
  readonly argument: string;

  constructor(argument: string, message: string) {
    super(message);
    this.name = "InvalidClassifierArgumentError";
    this.argument = argument;
    Object.setPrototypeOf(this, InvalidClassifierArgumentError.prototype);
  }
}

export const RestartReadinessError = {
  InvalidThreadState: InvalidThreadStateError,
  InvalidClassifierArgument: InvalidClassifierArgumentError,
} as const;

function isWellFormedString(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= s.length) {
        return false;
      }
      const next = s.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (types.isProxy(value)) {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPlainJsonArray(value: unknown): value is unknown[] {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (types.isProxy(value)) {
    return false;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return Object.getPrototypeOf(value) === Array.prototype;
}

/**
 * Pure classifier operating directly on already-parsed lossless RPC input.
 * Does not perform JSON.stringify or JSON.parse roundtrips.
 */
export function classifyThreadState(
  result: unknown,
  expectedThreadId: string,
  quietSeconds: bigint,
  nowSeconds: bigint,
): RestartReadinessState {
  if (
    typeof expectedThreadId !== "string" ||
    !isWellFormedString(expectedThreadId)
  ) {
    throw new InvalidClassifierArgumentError(
      "expectedThreadId",
      "expectedThreadId must be a well-formed string",
    );
  }

  if (
    typeof quietSeconds !== "bigint" ||
    quietSeconds < 0n ||
    quietSeconds > U64_MAX
  )
  {
    throw new InvalidClassifierArgumentError(
      "quietSeconds",
      "quietSeconds must be a bigint between 0 and U64_MAX",
    );
  }

  if (
    typeof nowSeconds !== "bigint" ||
    nowSeconds < 0n ||
    nowSeconds > U64_MAX
  )
  {
    throw new InvalidClassifierArgumentError(
      "nowSeconds",
      "nowSeconds must be a bigint between 0 and U64_MAX",
    );
  }

  if (!isPlainJsonObject(result)) {
    throw new InvalidThreadStateError(expectedThreadId, "missing thread object");
  }

  const threadDesc = Object.getOwnPropertyDescriptor(result, "thread");
  if (
    !threadDesc ||
    threadDesc.get !== undefined ||
    threadDesc.set !== undefined ||
    !isPlainJsonObject(threadDesc.value)
  ) {
    throw new InvalidThreadStateError(expectedThreadId, "missing thread object");
  }

  const thread = threadDesc.value;

  const idDesc = Object.getOwnPropertyDescriptor(thread, "id");
  if (
    !idDesc ||
    idDesc.get !== undefined ||
    idDesc.set !== undefined ||
    typeof idDesc.value !== "string"
  ) {
    throw new InvalidThreadStateError(expectedThreadId, "missing thread id");
  }

  const id = idDesc.value;
  if (id !== expectedThreadId) {
    throw new InvalidThreadStateError(expectedThreadId, "thread id mismatch");
  }

  const updatedAtDesc = Object.getOwnPropertyDescriptor(thread, "updatedAt");
  if (
    !updatedAtDesc ||
    updatedAtDesc.get !== undefined ||
    updatedAtDesc.set !== undefined
  ) {
    throw new InvalidThreadStateError(
      expectedThreadId,
      "missing or invalid updatedAt",
    );
  }

  const updatedAt = updatedAtDesc.value;
  if (
    typeof updatedAt !== "bigint" ||
    updatedAt < 0n ||
    updatedAt > U64_MAX
  ) {
    throw new InvalidThreadStateError(
      expectedThreadId,
      "missing or invalid updatedAt",
    );
  }

  const statusDesc = Object.getOwnPropertyDescriptor(thread, "status");
  if (
    !statusDesc ||
    statusDesc.get !== undefined ||
    statusDesc.set !== undefined ||
    !isPlainJsonObject(statusDesc.value)
  ) {
    throw new InvalidThreadStateError(expectedThreadId, "missing status object");
  }

  const status = statusDesc.value;

  const typeDesc = Object.getOwnPropertyDescriptor(status, "type");
  if (
    !typeDesc ||
    typeDesc.get !== undefined ||
    typeDesc.set !== undefined ||
    typeof typeDesc.value !== "string"
  ) {
    throw new InvalidThreadStateError(expectedThreadId, "missing status type");
  }

  const statusType = typeDesc.value;

  switch (statusType) {
    case "active": {
      const flagsDesc = Object.getOwnPropertyDescriptor(status, "activeFlags");
      if (
        !flagsDesc ||
        flagsDesc.get !== undefined ||
        flagsDesc.set !== undefined ||
        !isPlainJsonArray(flagsDesc.value)
      ) {
        throw new InvalidThreadStateError(
          expectedThreadId,
          "active status has no activeFlags array",
        );
      }

      const activeFlags = flagsDesc.value;
      const names: string[] = [];
      const flagsLen = activeFlags.length;
      for (let i = 0; i < flagsLen; i++) {
        const flagDesc = Object.getOwnPropertyDescriptor(activeFlags, String(i));
        if (
          !flagDesc ||
          flagDesc.get !== undefined ||
          flagDesc.set !== undefined ||
          typeof flagDesc.value !== "string"
        ) {
          throw new InvalidThreadStateError(
            expectedThreadId,
            "active flag is not text",
          );
        }
        const flag = flagDesc.value;
        if (flag !== "waitingOnApproval" && flag !== "waitingOnUserInput") {
          throw new InvalidThreadStateError(
            expectedThreadId,
            `unknown active flag ${rustDebugString(flag)}`,
          );
        }
        names.push(flag);
      }

      const suffix = names.length === 0 ? "" : ` flags=${names.join(",")}`;
      return {
        status: "Blocked",
        reason: `thread ${expectedThreadId} is active${suffix}`,
      };
    }

    case "systemError": {
      return {
        status: "Blocked",
        reason: `thread ${expectedThreadId} has systemError status`,
      };
    }

    case "idle":
    case "notLoaded": {
      if (updatedAt > nowSeconds || nowSeconds - updatedAt < quietSeconds) {
        return {
          status: "Blocked",
          reason: `thread ${expectedThreadId} is recent: updated_at=${updatedAt} quiet_seconds=${quietSeconds}`,
        };
      }
      return { status: "Ready" };
    }

    default: {
      throw new InvalidThreadStateError(
        expectedThreadId,
        `unknown status type ${rustDebugString(statusType)}`,
      );
    }
  }
}

/**
 * Separate wrapper parsing raw JSON text losslessly before classification.
 */
export function classifyThreadStateFromRawJson(
  rawJson: string,
  expectedThreadId: string,
  quietSeconds: bigint,
  nowSeconds: bigint,
): RestartReadinessState {
  const parsed = parseSerdeValue(rawJson);
  return classifyThreadState(parsed, expectedThreadId, quietSeconds, nowSeconds);
}
