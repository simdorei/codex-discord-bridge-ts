import type { JsonObject } from "./async-resolution-json-helpers.ts";
import {
  asI64,
  asJsonObject,
  asU64,
  getOwn,
  hasExactFieldCount,
  hasOwn,
  isJsonObject,
  optionalStrings,
  single,
  singleObject,
  strings,
  u32Field,
} from "./async-resolution-json-helpers.ts";

const CANONICAL_JOB_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function canonicalJobId(value: unknown): boolean {
  return typeof value === "string" && CANONICAL_JOB_ID_REGEX.test(value);
}

const PROPOSAL_ID_REGEX = /^[0-9a-f]{32}$/;

function isProposalId(value: unknown): boolean {
  return typeof value === "string" && PROPOSAL_ID_REGEX.test(value);
}

const SLASH_NAMES = new Set([
  "help",
  "list",
  "archived_list",
  "use",
  "status",
  "settings",
  "where",
  "context",
  "usage",
  "new",
  "ask",
  "interview",
  "doctor",
  "approval",
  "runners",
  "retract",
  "mirror_check",
  "bridge_sync",
  "qa_buttons",
]);

function isSlashName(name: unknown): boolean {
  return typeof name === "string" && SLASH_NAMES.has(name);
}

const BARE_COMMAND_NAMES = new Set([
  "Help",
  "Where",
  "Doctor",
  "Runners",
  "MirrorCheck",
  "QaButtons",
  "RestartCodex",
  "ForceRestartCodex",
  "Identity",
  "Resources",
  "Approval",
  "HostReboot",
]);

function optionalLimit(value: JsonObject, signed: boolean): boolean {
  if (!hasOwn(value, "limit")) {
    return true;
  }
  const lim = getOwn(value, "limit");
  if (lim === null) {
    return true;
  }
  if (signed) {
    const signedLim = asI64(lim);
    return signedLim !== undefined;
  }
  return u32Field(value, "limit");
}

function command(value: unknown): boolean {
  if (typeof value === "string") {
    return BARE_COMMAND_NAMES.has(value);
  }
  const pair = singleObject(value);
  if (pair === undefined) {
    return false;
  }
  const [name, fields] = pair;
  switch (name) {
    case "Ask":
    case "New":
    case "Interview":
    case "Steer":
      return strings(fields, ["prompt"]);
    case "List":
    case "ArchivedList":
      return u32Field(fields, "limit");
    case "Usage":
      return u32Field(fields, "days");
    case "Use":
    case "DeleteArchivePreview":
    case "DeleteArchiveConfirm":
      return strings(fields, ["reference"]);
    case "SavedRequest":
      return strings(fields, ["request_id"]);
    case "DiscardRequest":
      return (
        hasExactFieldCount(fields, 1) && canonicalJobId(getOwn(fields, "job_id"))
      );
    case "Status":
    case "Retract":
    case "Recover":
    case "Repair":
    case "Resume":
      return optionalStrings(fields, ["reference"]);
    case "Settings":
      return optionalStrings(fields, [
        "reference",
        "model",
        "effort",
        "speed",
      ]);
    case "SettingsOptions":
      return optionalStrings(fields, ["reference", "field"]);
    case "AutoReserve":
      return (
        optionalStrings(fields, ["reference"]) &&
        typeof getOwn(fields, "enabled") === "boolean"
      );
    case "Context":
      return (
        typeof getOwn(fields, "all_threads") === "boolean" &&
        typeof getOwn(fields, "refresh") === "boolean" &&
        u32Field(fields, "limit")
      );
    case "MirrorInspect":
      return (
        optionalLimit(fields, false) &&
        typeof getOwn(fields, "list") === "boolean"
      );
    case "BridgeSync":
      return optionalLimit(fields, true);
    case "Open":
      return (
        strings(fields, ["reference"]) &&
        typeof getOwn(fields, "abort") === "boolean"
      );
    default:
      return false;
  }
}

function component(value: unknown): boolean {
  const pair = singleObject(value);
  if (pair === undefined) {
    return false;
  }
  const [kind, fields] = pair;
  switch (kind) {
    case "AsyncChoice": {
      if (!strings(fields, ["question_id"])) {
        return false;
      }
      const opt = asU64(getOwn(fields, "option"));
      if (opt === undefined) {
        return false;
      }
      return opt < 25n;
    }
    case "RecoveryPublicationDecision": {
      if (!hasExactFieldCount(fields, 3)) {
        return false;
      }
      const proposalId = getOwn(fields, "proposal_id");
      if (!isProposalId(proposalId)) {
        return false;
      }
      const rev = asI64(getOwn(fields, "revision"));
      if (rev === undefined) {
        return false;
      }
      if (rev <= 0n) {
        return false;
      }
      const decision = getOwn(fields, "decision");
      return decision === "ApproveExact" || decision === "KeepHeld";
    }
    case "RecoveryAbandonDecision": {
      if (!hasExactFieldCount(fields, 3)) {
        return false;
      }
      const proposalId = getOwn(fields, "proposal_id");
      if (!isProposalId(proposalId)) {
        return false;
      }
      const rev = asI64(getOwn(fields, "revision"));
      if (rev === undefined) {
        return false;
      }
      if (rev <= 0n) {
        return false;
      }
      const decision = getOwn(fields, "decision");
      return decision === "AbandonOnly" || decision === "KeepHeld";
    }
    case "Busy": {
      if (!strings(fields, ["choice_id"])) {
        return false;
      }
      const action = getOwn(fields, "action");
      return action === "Steer" || action === "Queue" || action === "Ignore";
    }
    case "Input":
      return strings(fields, ["thread_id", "value"]);
    case "BoundInput":
      return strings(fields, [
        "thread_fingerprint",
        "request_fingerprint",
        "value",
      ]);
    case "Approval":
    case "BoundApproval": {
      const identity =
        kind === "Approval"
          ? strings(fields, ["thread_id"])
          : strings(fields, ["thread_fingerprint", "request_fingerprint"]);
      if (!identity) {
        return false;
      }
      const answer = getOwn(fields, "answer");
      return (
        answer === "Approve" ||
        answer === "ApproveSession" ||
        answer === "Reject" ||
        answer === "Cancel"
      );
    }
    default:
      return false;
  }
}

function work(value: unknown): boolean {
  const pair = singleObject(value);
  if (pair === undefined) {
    return false;
  }
  const [kind, fields] = pair;
  switch (kind) {
    case "Slash": {
      const name = getOwn(fields, "name");
      if (!isSlashName(name)) {
        return false;
      }
      const valuesObj = asJsonObject(getOwn(fields, "values"));
      if (valuesObj === undefined) {
        return false;
      }
      for (const key of Object.keys(valuesObj)) {
        if (!Object.hasOwn(valuesObj, key)) {
          continue;
        }
        const v = valuesObj[key];
        const vPair = single(v);
        if (vPair === undefined) {
          return false;
        }
        const [valKind, valBody] = vPair;
        if (valKind === "Boolean") {
          if (typeof valBody !== "boolean") {
            return false;
          }
        } else if (valKind === "Integer") {
          const intVal = asI64(valBody);
          if (intVal === undefined) {
            return false;
          }
        } else if (valKind === "String") {
          if (typeof valBody !== "string") {
            return false;
          }
        } else {
          return false;
        }
      }
      return true;
    }
    case "Autocomplete":
      return (
        strings(fields, ["command_name", "option_name", "current"]) &&
        optionalStrings(fields, ["selected_model"])
      );
    case "Component":
      return component(fields);
    default:
      return false;
  }
}

function validatePlan(value: unknown): boolean {
  const pair = single(value);
  if (pair === undefined) {
    return false;
  }
  const [kind, body] = pair;
  if (kind === "Execute") {
    return command(body);
  }
  if (kind === "Respond" || kind === "Error" || kind === "Ignore") {
    return typeof body === "string";
  }
  return false;
}

function validateLifecycleBinding(value: unknown): boolean {
  if (!isJsonObject(value)) {
    return false;
  }
  if (!strings(value, ["target"])) {
    return false;
  }
  const route = getOwn(value, "route");
  if (route !== "Mapped" && route !== "Explicit" && route !== "Selected") {
    return false;
  }
  return command(getOwn(value, "command"));
}

const KNOWN_ROOT_KEYS = [
  "plan",
  "lifecycle_binding",
  "work",
  "command",
] as const;

export function asyncLifecycleOrdinary(payload: unknown): boolean {
  if (!isJsonObject(payload)) {
    return false;
  }
  const version = asU64(getOwn(payload, "version"));
  if (version === undefined) {
    return false;
  }
  if (version !== 1n) {
    return false;
  }

  let recognized = false;
  for (const key of KNOWN_ROOT_KEYS) {
    if (!hasOwn(payload, key)) {
      continue;
    }
    const value = getOwn(payload, key);
    if (value === null) {
      continue;
    }

    let valid = false;
    if (key === "plan") {
      valid = validatePlan(value);
    } else if (key === "lifecycle_binding") {
      valid = validateLifecycleBinding(value);
    } else if (key === "work") {
      valid = work(value);
    } else if (key === "command") {
      valid = isSlashName(value);
    }

    if (!valid) {
      return false;
    }
    recognized = true;
  }

  return recognized;
}

export const ordinary = asyncLifecycleOrdinary;
