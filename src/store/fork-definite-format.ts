export const DEFINITE_FORK_ERROR_PREFIX =
  "[cdr-rust:app-server-fork-definite:v1] ";

export const UNRESOLVED_FORK_ERROR_PREFIX =
  "[cdr-rust:app-server-fork-unresolved:v1] ";

const PREVIOUS_ERROR_LABEL = "\nPrevious error: ";
const FALLBACK_FORK_ERROR =
  "app-server fork failed without an error message";

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

function validateStringScalar(name: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  if (hasLoneSurrogates(value)) {
    throw new TypeError(`${name} contains lone surrogates`);
  }
  return value;
}

function takeScalars(s: string, count: number): string {
  if (count <= 0) {
    return "";
  }
  let result = "";
  let seen = 0;
  for (const ch of s) {
    if (seen >= count) {
      break;
    }
    result += ch;
    seen++;
  }
  return result;
}

export function previousNonForkError(storedError: string): string {
  validateStringScalar("storedError", storedError);
  const trimmedStored = rustTrim(storedError);

  let value: string | undefined;
  if (trimmedStored.startsWith(DEFINITE_FORK_ERROR_PREFIX)) {
    value = trimmedStored.slice(DEFINITE_FORK_ERROR_PREFIX.length);
  } else if (trimmedStored.startsWith(UNRESOLVED_FORK_ERROR_PREFIX)) {
    value = trimmedStored.slice(UNRESOLVED_FORK_ERROR_PREFIX.length);
  }

  let previous: string;
  if (value !== undefined) {
    const markerIndex = value.lastIndexOf(PREVIOUS_ERROR_LABEL);
    if (markerIndex !== -1) {
      previous = value.slice(markerIndex + PREVIOUS_ERROR_LABEL.length);
    } else {
      previous = "";
    }
  } else {
    previous = trimmedStored;
  }

  if (
    previous.startsWith(DEFINITE_FORK_ERROR_PREFIX) ||
    previous.startsWith(UNRESOLVED_FORK_ERROR_PREFIX)
  ) {
    return "";
  }

  return takeScalars(previous, 1000);
}

export function definiteMessage(
  forkError: string,
  previousError: string,
): string {
  validateStringScalar("forkError", forkError);
  validateStringScalar("previousError", previousError);
  if (previousError.length === 0) {
    return `${DEFINITE_FORK_ERROR_PREFIX}${forkError}`;
  }
  return `${DEFINITE_FORK_ERROR_PREFIX}${forkError}\nPrevious error: ${previousError}`;
}

export function definiteNotice(
  forkError: string,
  previousError: string,
): string {
  validateStringScalar("forkError", forkError);
  validateStringScalar("previousError", previousError);
  let content =
    `The Codex ownership fork definitely failed before a target was created. This request remains durable and can be retried safely.\nFork error: ${forkError}`;
  if (previousError.length !== 0) {
    content += `\nPrevious error: ${previousError}`;
  }
  return content;
}

export function boundedForkError(error: string): string {
  validateStringScalar("error", error);
  const trimmed = rustTrim(error);
  const effective =
    trimmed.length === 0 ? FALLBACK_FORK_ERROR : trimmed;
  return takeScalars(effective, 1000);
}
