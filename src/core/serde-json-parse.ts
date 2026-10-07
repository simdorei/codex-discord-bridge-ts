/**
 * Faithful TypeScript implementation of serde_json 1.0.151 Value parser
 * with DEFAULT features (not float_roundtrip, no arbitrary_precision, no preserve_order).
 */

type JsonReviverContext = { source?: string };
type JsonReviver = (key: string, value: unknown, context?: JsonReviverContext) => unknown;

const JSON_NUMBER_REGEX = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const POW10: Float64Array = (() => {
  const table = new Float64Array(309);
  for (let i = 0; i < 309; i++) {
    table[i] = Number("1e" + i);
  }
  return table;
})();

function isWellFormedStr(s: string): boolean {
  const isWellFormed = (String.prototype as { isWellFormed?: (this: string) => boolean }).isWellFormed;
  if (typeof isWellFormed === "function") {
    return isWellFormed.call(s);
  }
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

/**
 * Pre-scans the input string to:
 * 1. Enforce Rust serde_json default recursion limit of 128 nesting depth (depth >= 128 rejected).
 * 2. Validate all quoted string tokens (including duplicate/overwritten keys and root strings)
 *    and reject lone UTF-16 surrogates.
 * 3. Validate all numeric tokens outside quoted strings before native JSON.parse,
 *    including overwritten duplicate keys.
 */
function validateStructureAndStrings(text: string): void {
  let depth = 0;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text.charCodeAt(i);

    if (ch === 0x22) { // '"'
      const start = i;
      i++;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (c === 0x5c) { // '\\'
          i += 2;
        } else if (c === 0x22) { // '"'
          i++;
          break;
        } else {
          i++;
        }
      }
      const rawToken = text.slice(start, i);
      let parsedStr: string;
      try {
        parsedStr = JSON.parse(rawToken);
      } catch (e) {
        throw new SyntaxError(
          `Invalid JSON string token: ${e instanceof Error ? e.message : String(e)}`
        );
      }
      if (!isWellFormedStr(parsedStr)) {
        throw new SyntaxError("Lone UTF-16 surrogate in string token");
      }
    } else if (ch === 0x7b || ch === 0x5b) { // '{' or '['
      depth++;
      if (depth >= 128) {
        throw new SyntaxError("Recursion limit exceeded: depth >= 128");
      }
      i++;
    } else if (ch === 0x7d || ch === 0x5d) { // '}' or ']'
      depth--;
      i++;
    } else if (ch === 0x2d || (ch >= 0x30 && ch <= 0x39)) { // '-' or '0'-'9'
      const start = i;
      i++;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (
          (c >= 0x30 && c <= 0x39) ||
          c === 0x2d ||
          c === 0x2b ||
          c === 0x2e ||
          c === 0x65 ||
          c === 0x45
        ) {
          i++;
        } else {
          break;
        }
      }
      const rawNum = text.slice(start, i);
      if (JSON_NUMBER_REGEX.test(rawNum)) {
        parseSerdeNumber(rawNum);
      }
    } else {
      i++;
    }
  }
}

function f64FromParts(
  positive: boolean,
  significand: bigint,
  mutExponent: number
): number {
  let f = Number(significand);
  let exponent = mutExponent;

  while (true) {
    const absExp = Math.abs(exponent);
    if (absExp <= 308) {
      const pow = POW10[absExp];
      if (pow === undefined) {
        throw new RangeError("number out of range");
      }
      if (exponent >= 0) {
        f *= pow;
        if (!Number.isFinite(f)) {
          throw new RangeError("number out of range");
        }
      } else {
        f /= pow;
      }
      break;
    } else {
      if (f === 0.0) {
        break;
      }
      if (exponent >= 0) {
        throw new RangeError("number out of range");
      }
      f /= 1e308;
      exponent += 308;
    }
  }

  if (positive) {
    return Object.is(f, -0) ? 0 : f;
  } else {
    return Object.is(f, 0) ? -0 : -f;
  }
}

function parseExponentOverflow(
  positive: boolean,
  zeroSignificand: boolean,
  positiveExp: boolean,
  pos: number,
  s: string
): number {
  if (!zeroSignificand && positiveExp) {
    throw new RangeError("number out of range");
  }

  while (pos < s.length && s.charAt(pos) >= "0" && s.charAt(pos) <= "9") {
    pos++;
  }

  return positive ? 0.0 : -0.0;
}

function parseExponent(
  positive: boolean,
  significand: bigint,
  startingExp: number,
  pos: number,
  s: string
): number {
  pos++; // eat 'e' or 'E'

  let positiveExp = true;
  if (pos < s.length) {
    const signChar = s.charAt(pos);
    if (signChar === "+") {
      pos++;
    } else if (signChar === "-") {
      positiveExp = false;
      pos++;
    }
  }

  if (pos >= s.length) {
    throw new SyntaxError("Invalid number: missing exponent digits");
  }

  const nextChar = s.charAt(pos++);
  if (!(nextChar >= "0" && nextChar <= "9")) {
    throw new SyntaxError("Invalid number: missing exponent digits");
  }

  let exp = nextChar.charCodeAt(0) - 48;

  while (pos < s.length) {
    const c = s.charAt(pos);
    if (c >= "0" && c <= "9") {
      pos++;
      const digit = c.charCodeAt(0) - 48;
      if (exp * 10 + digit > 2147483647) {
        const zeroSignificand = significand === 0n;
        return parseExponentOverflow(positive, zeroSignificand, positiveExp, pos, s);
      }
      exp = exp * 10 + digit;
    } else {
      break;
    }
  }

  let finalExp: number;
  if (positiveExp) {
    finalExp = startingExp + exp;
    if (finalExp > 2147483647) finalExp = 2147483647;
    else if (finalExp < -2147483648) finalExp = -2147483648;
  } else {
    finalExp = startingExp - exp;
    if (finalExp > 2147483647) finalExp = 2147483647;
    else if (finalExp < -2147483648) finalExp = -2147483648;
  }

  return f64FromParts(positive, significand, finalExp);
}

function parseDecimalOverflow(
  positive: boolean,
  significand: bigint,
  exponent: number,
  pos: number,
  s: string
): number {
  while (pos < s.length && s.charAt(pos) >= "0" && s.charAt(pos) <= "9") {
    pos++;
  }

  if (pos < s.length && (s.charAt(pos) === "e" || s.charAt(pos) === "E")) {
    return parseExponent(positive, significand, exponent, pos, s);
  }
  return f64FromParts(positive, significand, exponent);
}

function parseDecimal(
  positive: boolean,
  significand: bigint,
  exponentBefore: number,
  pos: number,
  s: string
): number {
  pos++; // eat '.'

  let exponentAfter = 0;
  let sig = significand;

  while (pos < s.length) {
    const c = s.charAt(pos);
    if (c >= "0" && c <= "9") {
      const digit = BigInt(c);
      const nextSig = sig * 10n + digit;
      if (nextSig > 18446744073709551615n) {
        const exponent = exponentBefore + exponentAfter;
        return parseDecimalOverflow(positive, sig, exponent, pos, s);
      }
      pos++;
      sig = nextSig;
      exponentAfter -= 1;
    } else {
      break;
    }
  }

  if (exponentAfter === 0) {
    throw new SyntaxError("Invalid number: missing digits after decimal point");
  }

  const exponent = exponentBefore + exponentAfter;
  if (pos < s.length && (s.charAt(pos) === "e" || s.charAt(pos) === "E")) {
    return parseExponent(positive, sig, exponent, pos, s);
  }
  return f64FromParts(positive, sig, exponent);
}

function parseLongInteger(
  positive: boolean,
  significand: bigint,
  pos: number,
  s: string
): number {
  let exponent = 0;
  while (pos < s.length) {
    const c = s.charAt(pos);
    if (c >= "0" && c <= "9") {
      pos++;
      exponent++;
    } else if (c === ".") {
      return parseDecimal(positive, significand, exponent, pos, s);
    } else if (c === "e" || c === "E") {
      return parseExponent(positive, significand, exponent, pos, s);
    } else {
      break;
    }
  }
  return f64FromParts(positive, significand, exponent);
}

function parseNumberTail(
  positive: boolean,
  significand: bigint,
  pos: number,
  s: string
): bigint | number {
  if (pos < s.length) {
    const c = s.charAt(pos);
    if (c === ".") {
      return parseDecimal(positive, significand, 0, pos, s);
    }
    if (c === "e" || c === "E") {
      return parseExponent(positive, significand, 0, pos, s);
    }
  }

  if (positive) {
    return significand;
  } else {
    if (significand === 0n) {
      return -0;
    }
    if (significand <= 9223372036854775808n) {
      return -significand;
    } else {
      return -Number(significand);
    }
  }
}

function parseSerdeNumber(s: string): bigint | number {
  if (!JSON_NUMBER_REGEX.test(s)) {
    throw new SyntaxError(`Invalid number grammar: ${s}`);
  }

  let pos = 0;
  let positive = true;
  if (s.charCodeAt(pos) === 0x2d) { // '-'
    positive = false;
    pos++;
  }

  const firstChar = s.charAt(pos++);
  if (firstChar === "0") {
    if (pos < s.length && s.charAt(pos) >= "0" && s.charAt(pos) <= "9") {
      throw new SyntaxError("Invalid number: leading zero");
    }
    return parseNumberTail(positive, 0n, pos, s);
  }

  let significand = BigInt(firstChar);
  while (pos < s.length) {
    const c = s.charAt(pos);
    if (c >= "0" && c <= "9") {
      const digit = BigInt(c);
      const nextSig = significand * 10n + digit;
      if (nextSig > 18446744073709551615n) {
        return parseLongInteger(positive, significand, pos, s);
      }
      pos++;
      significand = nextSig;
    } else {
      break;
    }
  }

  return parseNumberTail(positive, significand, pos, s);
}

export function parseSerdeValue<T = unknown>(text: string): T {
  if (typeof text !== "string") {
    throw new TypeError("Expected string input");
  }

  validateStructureAndStrings(text);

  const reviver: JsonReviver = (_key: string, value: unknown, context?: JsonReviverContext): unknown => {
    if (typeof value === "number") {
      const raw = context?.source;
      if (typeof raw !== "string" || !JSON_NUMBER_REGEX.test(raw)) {
        throw new SyntaxError("Missing or invalid numeric source context");
      }
      return parseSerdeNumber(raw);
    }
    return value;
  };

  return (JSON.parse as (text: string, reviver?: JsonReviver) => unknown)(text, reviver) as T;
}
