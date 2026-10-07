const LAST_ERROR_LIMIT = 1000;
const PREVIOUS_ERROR_LIMIT = 240;
const PREVIOUS_ERROR_LABEL = "\nPrevious error: ";

export const UNRESOLVED_FORK_ERROR_PREFIX =
  "[cdr-rust:app-server-fork-unresolved:v1] ";

export const FailurePhase = Object.freeze({
  ForkOutcome: "ForkOutcome",
  Finalize: "Finalize",
  Cancellation: "Cancellation",
} as const);

export type FailurePhase =
  (typeof FailurePhase)[keyof typeof FailurePhase];

function hasLoneSurrogates(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      i++;
      if (i >= s.length) {
        return true;
      }
      const next = s.charCodeAt(i);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
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

function rustTrimStart(s: string): string {
  let start = 0;
  while (start < s.length && isRustWhitespace(s.charCodeAt(start))) {
    start++;
  }
  return s.slice(start);
}

function rustTrim(s: string): string {
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

function countUnicodeScalars(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      i++;
    }
    count++;
  }
  return count;
}

function takeUnicodeScalars(s: string, limit: number): string {
  if (limit <= 0) {
    return "";
  }
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      i++;
    }
    count++;
    if (count >= limit) {
      return s.slice(0, i + 1);
    }
  }
  return s;
}

function bounded(value: string, limit: number): string {
  const trimmed = rustTrim(value);
  return takeUnicodeScalars(trimmed, limit);
}

function validateStringScalar(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  if (hasLoneSurrogates(value)) {
    throw new TypeError(`${name} contains lone surrogates`);
  }
  return value;
}

function validateFailurePhase(phase: unknown): asserts phase is FailurePhase {
  if (
    phase !== FailurePhase.ForkOutcome &&
    phase !== FailurePhase.Finalize &&
    phase !== FailurePhase.Cancellation
  ) {
    throw new TypeError("invalid failure phase");
  }
}

export function priorError(
  storedError: string,
  previousForkError: string,
): string {
  validateStringScalar("storedError", storedError);
  validateStringScalar("previousForkError", previousForkError);

  const stored = rustTrim(storedError);
  if (!stored.startsWith(UNRESOLVED_FORK_ERROR_PREFIX)) {
    return bounded(stored, PREVIOUS_ERROR_LIMIT);
  }
  if (stored === unresolvedMessage(previousForkError, "")) {
    return "";
  }
  const encoded = stored.slice(UNRESOLVED_FORK_ERROR_PREFIX.length);
  const lastIndex = encoded.lastIndexOf(PREVIOUS_ERROR_LABEL);
  const candidate =
    lastIndex !== -1
      ? encoded.slice(lastIndex + PREVIOUS_ERROR_LABEL.length)
      : "";
  if (
    candidate.startsWith(UNRESOLVED_FORK_ERROR_PREFIX) ||
    stored !== unresolvedMessage(previousForkError, candidate)
  ) {
    return "";
  }
  return bounded(candidate, PREVIOUS_ERROR_LIMIT);
}

export function unresolvedMessage(
  forkError: string,
  previousError: string,
): string {
  validateStringScalar("forkError", forkError);
  validateStringScalar("previousError", previousError);

  let cleanForkError = rustTrim(forkError);
  while (cleanForkError.startsWith(UNRESOLVED_FORK_ERROR_PREFIX)) {
    cleanForkError = cleanForkError.slice(UNRESOLVED_FORK_ERROR_PREFIX.length);
  }
  cleanForkError = rustTrimStart(cleanForkError);

  const previous = bounded(previousError, PREVIOUS_ERROR_LIMIT);
  const previousOverhead =
    previous.length === 0
      ? 0
      : countUnicodeScalars(PREVIOUS_ERROR_LABEL) + countUnicodeScalars(previous);
  const overhead =
    countUnicodeScalars(UNRESOLVED_FORK_ERROR_PREFIX) + previousOverhead;
  const latestLimit = Math.max(0, LAST_ERROR_LIMIT - overhead);
  const latest = bounded(cleanForkError, latestLimit);

  if (previous.length === 0) {
    return `${UNRESOLVED_FORK_ERROR_PREFIX}${latest}`;
  }
  return `${UNRESOLVED_FORK_ERROR_PREFIX}${latest}${PREVIOUS_ERROR_LABEL}${previous}`;
}

export function unresolvedNotice(
  forkError: string,
  previousError: string,
  phase: FailurePhase,
): string {
  validateStringScalar("forkError", forkError);
  validateStringScalar("previousError", previousError);
  validateFailurePhase(phase);

  let content: string;
  switch (phase) {
    case FailurePhase.ForkOutcome:
      content =
        "The Codex ownership fork result is uncertain. This request remains queued and will not run until recovery, preventing a duplicate response.\nFork error: " +
        forkError;
      break;
    case FailurePhase.Finalize:
      content =
        "The Codex ownership fork target was created, but local routing finalization failed. This request remains queued and will not run until recovery, preventing a duplicate response.\nFinalize error: " +
        forkError;
      break;
    case FailurePhase.Cancellation:
      content =
        "The Codex ownership fork failed and its cancellation could not be confirmed. This request remains queued and will not run until recovery, preventing a duplicate response.\nFailure details: " +
        forkError;
      break;
    default: {
      const exhaustiveCheck: never = phase;
      throw new TypeError("invalid failure phase");
    }
  }

  if (previousError.length > 0) {
    content += PREVIOUS_ERROR_LABEL + previousError;
  }
  return content;
}
