export const CANCELLATION_FAILURE_PREFIX =
  "[cdr-rust:app-server-fork-cancellation-failure:v1] ";

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

function takeScalars(s: string, limit: number): string {
  if (limit <= 0) {
    return "";
  }
  let count = 0;
  let result = "";
  for (const scalar of s) {
    result += scalar;
    count++;
    if (count >= limit) {
      break;
    }
  }
  return result;
}

function boundedFragment(
  value: string,
  limit: number,
  fallback: string,
): string {
  const trimmed = rustTrim(value);
  const selected = trimmed.length === 0 ? fallback : trimmed;
  return takeScalars(selected, limit);
}

export function combinedForkCancellationError(
  forkError: string,
  cancellationError: string,
  previousError: string,
): string {
  validateStringScalar("forkError", forkError);
  validateStringScalar("cancellationError", cancellationError);
  validateStringScalar("previousError", previousError);

  const forkFragment = boundedFragment(
    forkError,
    320,
    "fork failed without an error message",
  );
  const cancellationFragment = boundedFragment(
    cancellationError,
    320,
    "handoff cancellation failed without an error message",
  );
  const base = `${CANCELLATION_FAILURE_PREFIX}Fork error: ${forkFragment}\nCancellation error: ${cancellationFragment}`;

  if (previousError.startsWith(base)) {
    return previousError;
  }

  const previous = boundedFragment(previousError, 240, "");
  const combined =
    previous.length === 0 ? base : `${base}\nPrevious error: ${previous}`;
  return takeScalars(combined, 1000);
}
