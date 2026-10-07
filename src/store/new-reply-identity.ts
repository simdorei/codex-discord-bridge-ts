/**
 * Standalone typed parser for Durable Identity of a /new first turn.
 * Implements strict acceptance parity with serde_json 1.0.151 / serde 1.0.228 oracle.
 */

export type IngressKind = "message" | "interaction" | "action";

export interface Identity {
  ingress_id: string;
  job_id: string;
  thread_id: string;
  cwd: string;
  state_db: string;
  channel_id: bigint;
  origin_channel_id: bigint;
  event_id: bigint | null;
  kind: IngressKind;
  creation_generation: bigint;
  prompt_sha256: string;
  acknowledgement: string;
}

export class NewReplyIdentityParseError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(`${message} at position ${position}`);
    this.name = "NewReplyIdentityParseError";
    this.position = position;
  }
}

const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;

const CONTAINER_ARRAY = 1;
const CONTAINER_OBJECT = 2;

const STATE_ARRAY_START = 0;
const STATE_ARRAY_AFTER_VALUE = 1;
const STATE_ARRAY_AFTER_COMMA = 2;

const STATE_OBJECT_START = 0;
const STATE_OBJECT_AFTER_KEY = 1;
const STATE_OBJECT_AFTER_COLON = 2;
const STATE_OBJECT_AFTER_VALUE = 3;
const STATE_OBJECT_AFTER_COMMA = 4;

function isWellFormedUtf16(s: string): boolean {
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= len) {
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

function parseHex4(raw: string, pos: number): number {
  if (pos + 4 > raw.length) {
    throw new NewReplyIdentityParseError("unexpected end of hex escape", pos);
  }
  let val = 0;
  for (let i = 0; i < 4; i++) {
    const c = raw.charCodeAt(pos + i);
    let digit = -1;
    if (c >= 0x30 && c <= 0x39) digit = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) digit = c - 0x61 + 10;
    else if (c >= 0x41 && c <= 0x46) digit = c - 0x41 + 10;
    else {
      throw new NewReplyIdentityParseError("invalid hex digit in escape", pos + i);
    }
    val = (val << 4) | digit;
  }
  return val;
}

function isDelimiter(ch: number): boolean {
  return (
    ch === 0x20 ||
    ch === 0x09 ||
    ch === 0x0a ||
    ch === 0x0d ||
    ch === 0x2c ||
    ch === 0x5d ||
    ch === 0x7d ||
    ch === 0x3a
  );
}

class IdentityParser {
  private readonly raw: string;
  private readonly len: number;
  private pos = 0;

  constructor(raw: string) {
    this.raw = raw;
    this.len = raw.length;
  }

  parse(): Identity {
    this.skipWhitespace();
    if (this.pos >= this.len) {
      throw new NewReplyIdentityParseError("unexpected EOF: empty input", this.pos);
    }

    const firstChar = this.raw.charCodeAt(this.pos);
    let identity: Identity;
    if (firstChar === 0x7b) {
      identity = this.parseObject();
    } else if (firstChar === 0x5b) {
      identity = this.parseArray();
    } else {
      throw new NewReplyIdentityParseError("expected '{' or '[' for Identity", this.pos);
    }

    this.skipWhitespace();
    if (this.pos < this.len) {
      throw new NewReplyIdentityParseError("trailing characters", this.pos);
    }

    return identity;
  }

  private skipWhitespace(): void {
    while (this.pos < this.len) {
      const ch = this.raw.charCodeAt(this.pos);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
        this.pos++;
      } else {
        break;
      }
    }
  }

  private parseStrictString(): string {
    this.skipWhitespace();
    if (this.pos >= this.len || this.raw.charCodeAt(this.pos) !== 0x22) {
      throw new NewReplyIdentityParseError("expected string starting with '\"'", this.pos);
    }
    this.pos++; // skip opening '"'

    let result = "";
    let segmentStart = this.pos;

    while (this.pos < this.len) {
      const ch = this.raw.charCodeAt(this.pos);
      if (ch === 0x22) {
        result += this.raw.slice(segmentStart, this.pos);
        this.pos++;
        return result;
      }
      if (ch < 0x20) {
        throw new NewReplyIdentityParseError("unescaped control character in string", this.pos);
      }
      if (ch === 0x5c) {
        result += this.raw.slice(segmentStart, this.pos);
        this.pos++;
        if (this.pos >= this.len) {
          throw new NewReplyIdentityParseError("unexpected EOF in escape sequence", this.pos);
        }
        const esc = this.raw.charCodeAt(this.pos++);
        switch (esc) {
          case 0x22: result += '"'; break;
          case 0x5c: result += '\\'; break;
          case 0x2f: result += '/'; break;
          case 0x62: result += '\b'; break;
          case 0x66: result += '\f'; break;
          case 0x6e: result += '\n'; break;
          case 0x72: result += '\r'; break;
          case 0x74: result += '\t'; break;
          case 0x75: {
            const code = parseHex4(this.raw, this.pos);
            this.pos += 4;
            if (code >= 0xd800 && code <= 0xdbff) {
              if (
                this.pos + 6 <= this.len &&
                this.raw.charCodeAt(this.pos) === 0x5c &&
                this.raw.charCodeAt(this.pos + 1) === 0x75
              ) {
                const low = parseHex4(this.raw, this.pos + 2);
                if (low >= 0xdc00 && low <= 0xdfff) {
                  this.pos += 6;
                  const codepoint = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                  result += String.fromCodePoint(codepoint);
                  break;
                }
              }
              throw new NewReplyIdentityParseError("unexpected end of hex escape", this.pos);
            } else if (code >= 0xdc00 && code <= 0xdfff) {
              throw new NewReplyIdentityParseError("unexpected end of hex escape", this.pos);
            } else {
              result += String.fromCharCode(code);
            }
            break;
          }
          default:
            throw new NewReplyIdentityParseError("invalid escape sequence", this.pos - 1);
        }
        segmentStart = this.pos;
      } else {
        this.pos++;
      }
    }

    throw new NewReplyIdentityParseError("unexpected EOF in string", this.pos);
  }

  private parseKnownI64(): bigint {
    this.skipWhitespace();
    if (this.pos >= this.len) {
      throw new NewReplyIdentityParseError("expected i64", this.pos);
    }

    let negative = false;
    if (this.raw.charCodeAt(this.pos) === 0x2d) {
      negative = true;
      this.pos++;
      if (this.pos >= this.len) {
        throw new NewReplyIdentityParseError("expected digits after '-'", this.pos);
      }
    }

    const firstChar = this.raw.charCodeAt(this.pos);
    if (firstChar === 0x30) {
      this.pos++;
      if (this.pos < this.len) {
        const next = this.raw.charCodeAt(this.pos);
        if (next >= 0x30 && next <= 0x39) {
          throw new NewReplyIdentityParseError("leading zeros not allowed", this.pos);
        }
        if (next === 0x2e || next === 0x65 || next === 0x45) {
          throw new NewReplyIdentityParseError("floats not allowed for i64", this.pos);
        }
        if (!isDelimiter(next)) {
          throw new NewReplyIdentityParseError("unexpected character after number", this.pos);
        }
      }
      if (negative) {
        throw new NewReplyIdentityParseError("-0 is not a valid i64", this.pos);
      }
      return 0n;
    }

    if (firstChar >= 0x31 && firstChar <= 0x39) {
      const start = this.pos;
      this.pos++;
      while (this.pos < this.len && this.raw.charCodeAt(this.pos) >= 0x30 && this.raw.charCodeAt(this.pos) <= 0x39) {
        this.pos++;
      }
      const digitCount = this.pos - start;

      if (this.pos < this.len) {
        const next = this.raw.charCodeAt(this.pos);
        if (next === 0x2e || next === 0x65 || next === 0x45) {
          throw new NewReplyIdentityParseError("floats not allowed for i64", this.pos);
        }
        if (!isDelimiter(next)) {
          throw new NewReplyIdentityParseError("unexpected character after number", this.pos);
        }
      }

      if (digitCount > 19) {
        throw new NewReplyIdentityParseError("i64 overflow", start);
      }

      const digitsStr = this.raw.slice(start, this.pos);
      const val = BigInt(negative ? "-" + digitsStr : digitsStr);
      if (val < I64_MIN || val > I64_MAX) {
        throw new NewReplyIdentityParseError("i64 overflow", start);
      }
      return val;
    }

    throw new NewReplyIdentityParseError("expected i64 number", this.pos);
  }

  private parseOptionalI64(): bigint | null {
    this.skipWhitespace();
    if (this.pos >= this.len) {
      throw new NewReplyIdentityParseError("expected optional i64", this.pos);
    }

    if (this.raw.charCodeAt(this.pos) === 0x6e) {
      if (this.pos + 4 <= this.len && this.raw.slice(this.pos, this.pos + 4) === "null") {
        this.pos += 4;
        if (this.pos < this.len && !isDelimiter(this.raw.charCodeAt(this.pos))) {
          throw new NewReplyIdentityParseError("unexpected character after null", this.pos);
        }
        return null;
      }
      throw new NewReplyIdentityParseError("unexpected token", this.pos);
    }

    return this.parseKnownI64();
  }

  private parseIngressKind(): IngressKind {
    this.skipWhitespace();
    if (this.pos >= this.len) {
      throw new NewReplyIdentityParseError("expected IngressKind", this.pos);
    }

    const ch = this.raw.charCodeAt(this.pos);
    if (ch === 0x22) {
      const s = this.parseStrictString();
      if (s === "message" || s === "interaction" || s === "action") {
        return s;
      }
      throw new NewReplyIdentityParseError("unknown IngressKind variant: " + s, this.pos);
    }

    if (ch === 0x7b) {
      this.pos++;
      this.skipWhitespace();
      if (this.pos >= this.len || this.raw.charCodeAt(this.pos) !== 0x22) {
        throw new NewReplyIdentityParseError("expected string key for IngressKind object", this.pos);
      }
      const variant = this.parseStrictString();
      if (variant !== "message" && variant !== "interaction" && variant !== "action") {
        throw new NewReplyIdentityParseError("unknown IngressKind variant: " + variant, this.pos);
      }
      this.skipWhitespace();
      if (this.pos >= this.len || this.raw.charCodeAt(this.pos) !== 0x3a) {
        throw new NewReplyIdentityParseError("expected ':' after IngressKind variant key", this.pos);
      }
      this.pos++;
      this.skipWhitespace();
      if (this.pos + 4 > this.len || this.raw.slice(this.pos, this.pos + 4) !== "null") {
        throw new NewReplyIdentityParseError("expected null payload for IngressKind variant", this.pos);
      }
      this.pos += 4;
      if (this.pos < this.len && !isDelimiter(this.raw.charCodeAt(this.pos))) {
        throw new NewReplyIdentityParseError("unexpected character after null in IngressKind", this.pos);
      }
      this.skipWhitespace();
      if (this.pos >= this.len || this.raw.charCodeAt(this.pos) !== 0x7d) {
        throw new NewReplyIdentityParseError("expected '}' ending IngressKind object", this.pos);
      }
      this.pos++;
      return variant;
    }

    throw new NewReplyIdentityParseError("expected string or object for IngressKind", this.pos);
  }

  private skipUnknownString(): void {
    if (this.raw.charCodeAt(this.pos) !== 0x22) {
      throw new NewReplyIdentityParseError("expected '\"'", this.pos);
    }
    this.pos++;
    while (this.pos < this.len) {
      const ch = this.raw.charCodeAt(this.pos);
      if (ch === 0x22) {
        this.pos++;
        return;
      }
      if (ch < 0x20) {
        throw new NewReplyIdentityParseError("unescaped control character in string", this.pos);
      }
      if (ch === 0x5c) {
        this.pos++;
        if (this.pos >= this.len) {
          throw new NewReplyIdentityParseError("unexpected EOF in escape sequence", this.pos);
        }
        const esc = this.raw.charCodeAt(this.pos++);
        if (
          esc === 0x22 ||
          esc === 0x5c ||
          esc === 0x2f ||
          esc === 0x62 ||
          esc === 0x66 ||
          esc === 0x6e ||
          esc === 0x72 ||
          esc === 0x74
        ) {
          // valid simple escape
        } else if (esc === 0x75) {
          if (this.pos + 4 > this.len) {
            throw new NewReplyIdentityParseError("unexpected end of hex escape", this.pos);
          }
          for (let i = 0; i < 4; i++) {
            const h = this.raw.charCodeAt(this.pos + i);
            const isHex = (h >= 0x30 && h <= 0x39) || (h >= 0x61 && h <= 0x66) || (h >= 0x41 && h <= 0x46);
            if (!isHex) {
              throw new NewReplyIdentityParseError("invalid hex digit in escape", this.pos + i);
            }
          }
          this.pos += 4;
        } else {
          throw new NewReplyIdentityParseError("invalid escape sequence", this.pos - 1);
        }
      } else {
        this.pos++;
      }
    }
    throw new NewReplyIdentityParseError("unexpected EOF in string", this.pos);
  }

  private skipUnknownNumber(): void {
    if (this.raw.charCodeAt(this.pos) === 0x2d) {
      this.pos++;
      if (this.pos >= this.len) {
        throw new NewReplyIdentityParseError("expected digit after '-'", this.pos);
      }
    }

    const first = this.raw.charCodeAt(this.pos);
    if (first === 0x30) {
      this.pos++;
      if (this.pos < this.len) {
        const next = this.raw.charCodeAt(this.pos);
        if (next >= 0x30 && next <= 0x39) {
          throw new NewReplyIdentityParseError("leading zeros not allowed", this.pos);
        }
      }
    } else if (first >= 0x31 && first <= 0x39) {
      this.pos++;
      while (this.pos < this.len && this.raw.charCodeAt(this.pos) >= 0x30 && this.raw.charCodeAt(this.pos) <= 0x39) {
        this.pos++;
      }
    } else {
      throw new NewReplyIdentityParseError("expected digit", this.pos);
    }

    if (this.pos < this.len && this.raw.charCodeAt(this.pos) === 0x2e) {
      this.pos++;
      if (this.pos >= this.len || this.raw.charCodeAt(this.pos) < 0x30 || this.raw.charCodeAt(this.pos) > 0x39) {
        throw new NewReplyIdentityParseError("expected digit after '.'", this.pos);
      }
      this.pos++;
      while (this.pos < this.len && this.raw.charCodeAt(this.pos) >= 0x30 && this.raw.charCodeAt(this.pos) <= 0x39) {
        this.pos++;
      }
    }

    if (this.pos < this.len && (this.raw.charCodeAt(this.pos) === 0x65 || this.raw.charCodeAt(this.pos) === 0x45)) {
      this.pos++;
      if (this.pos < this.len && (this.raw.charCodeAt(this.pos) === 0x2b || this.raw.charCodeAt(this.pos) === 0x2d)) {
        this.pos++;
      }
      if (this.pos >= this.len || this.raw.charCodeAt(this.pos) < 0x30 || this.raw.charCodeAt(this.pos) > 0x39) {
        throw new NewReplyIdentityParseError("expected digit in exponent", this.pos);
      }
      this.pos++;
      while (this.pos < this.len && this.raw.charCodeAt(this.pos) >= 0x30 && this.raw.charCodeAt(this.pos) <= 0x39) {
        this.pos++;
      }
    }

    if (this.pos < this.len) {
      const ch = this.raw.charCodeAt(this.pos);
      if (!isDelimiter(ch)) {
        throw new NewReplyIdentityParseError("unexpected character after number", this.pos);
      }
    }
  }

  private skipLiteral(): void {
    const ch = this.raw.charCodeAt(this.pos);
    if (ch === 0x74) {
      if (this.pos + 4 <= this.len && this.raw.slice(this.pos, this.pos + 4) === "true") {
        this.pos += 4;
        if (this.pos < this.len && !isDelimiter(this.raw.charCodeAt(this.pos))) {
          throw new NewReplyIdentityParseError("unexpected character after true", this.pos);
        }
        return;
      }
    } else if (ch === 0x66) {
      if (this.pos + 5 <= this.len && this.raw.slice(this.pos, this.pos + 5) === "false") {
        this.pos += 5;
        if (this.pos < this.len && !isDelimiter(this.raw.charCodeAt(this.pos))) {
          throw new NewReplyIdentityParseError("unexpected character after false", this.pos);
        }
        return;
      }
    } else if (ch === 0x6e) {
      if (this.pos + 4 <= this.len && this.raw.slice(this.pos, this.pos + 4) === "null") {
        this.pos += 4;
        if (this.pos < this.len && !isDelimiter(this.raw.charCodeAt(this.pos))) {
          throw new NewReplyIdentityParseError("unexpected character after null", this.pos);
        }
        return;
      }
    }
    throw new NewReplyIdentityParseError("unexpected token in JSON", this.pos);
  }

  private skipPrimitive(ch: number): void {
    if (ch === 0x22) {
      this.skipUnknownString();
    } else if (ch === 0x2d || (ch >= 0x30 && ch <= 0x39)) {
      this.skipUnknownNumber();
    } else if (ch === 0x74 || ch === 0x66 || ch === 0x6e) {
      this.skipLiteral();
    } else {
      throw new NewReplyIdentityParseError("unexpected character in JSON value", this.pos);
    }
  }

  private skipContainers(initialType: number): void {
    const stackType: number[] = [initialType];
    const stackState: number[] = [
      initialType === CONTAINER_ARRAY ? STATE_ARRAY_START : STATE_OBJECT_START,
    ];

    while (stackType.length > 0) {
      this.skipWhitespace();
      if (this.pos >= this.len) {
        throw new NewReplyIdentityParseError("unexpected EOF in container", this.pos);
      }

      const depthIndex = stackType.length - 1;
      const currentType = stackType[depthIndex]!;
      const currentState = stackState[depthIndex]!;
      const ch = this.raw.charCodeAt(this.pos);

      if (currentType === CONTAINER_ARRAY) {
        if (currentState === STATE_ARRAY_START) {
          if (ch === 0x5d) {
            this.pos++;
            stackType.pop();
            stackState.pop();
          } else {
            stackState[depthIndex] = STATE_ARRAY_AFTER_VALUE;
            if (ch === 0x5b) {
              this.pos++;
              stackType.push(CONTAINER_ARRAY);
              stackState.push(STATE_ARRAY_START);
            } else if (ch === 0x7b) {
              this.pos++;
              stackType.push(CONTAINER_OBJECT);
              stackState.push(STATE_OBJECT_START);
            } else {
              this.skipPrimitive(ch);
            }
          }
        } else if (currentState === STATE_ARRAY_AFTER_VALUE) {
          if (ch === 0x2c) {
            this.pos++;
            stackState[depthIndex] = STATE_ARRAY_AFTER_COMMA;
          } else if (ch === 0x5d) {
            this.pos++;
            stackType.pop();
            stackState.pop();
          } else {
            throw new NewReplyIdentityParseError("expected ',' or ']' in array", this.pos);
          }
        } else {
          if (ch === 0x5d) {
            throw new NewReplyIdentityParseError("trailing comma in array", this.pos);
          }
          stackState[depthIndex] = STATE_ARRAY_AFTER_VALUE;
          if (ch === 0x5b) {
            this.pos++;
            stackType.push(CONTAINER_ARRAY);
            stackState.push(STATE_ARRAY_START);
          } else if (ch === 0x7b) {
            this.pos++;
            stackType.push(CONTAINER_OBJECT);
            stackState.push(STATE_OBJECT_START);
          } else {
            this.skipPrimitive(ch);
          }
        }
      } else {
        if (currentState === STATE_OBJECT_START) {
          if (ch === 0x7d) {
            this.pos++;
            stackType.pop();
            stackState.pop();
          } else if (ch === 0x22) {
            this.skipUnknownString();
            stackState[depthIndex] = STATE_OBJECT_AFTER_KEY;
          } else {
            throw new NewReplyIdentityParseError("expected string key or '}' in object", this.pos);
          }
        } else if (currentState === STATE_OBJECT_AFTER_KEY) {
          if (ch === 0x3a) {
            this.pos++;
            stackState[depthIndex] = STATE_OBJECT_AFTER_COLON;
          } else {
            throw new NewReplyIdentityParseError("expected ':' after object key", this.pos);
          }
        } else if (currentState === STATE_OBJECT_AFTER_COLON) {
          stackState[depthIndex] = STATE_OBJECT_AFTER_VALUE;
          if (ch === 0x5b) {
            this.pos++;
            stackType.push(CONTAINER_ARRAY);
            stackState.push(STATE_ARRAY_START);
          } else if (ch === 0x7b) {
            this.pos++;
            stackType.push(CONTAINER_OBJECT);
            stackState.push(STATE_OBJECT_START);
          } else {
            this.skipPrimitive(ch);
          }
        } else if (currentState === STATE_OBJECT_AFTER_VALUE) {
          if (ch === 0x2c) {
            this.pos++;
            stackState[depthIndex] = STATE_OBJECT_AFTER_COMMA;
          } else if (ch === 0x7d) {
            this.pos++;
            stackType.pop();
            stackState.pop();
          } else {
            throw new NewReplyIdentityParseError("expected ',' or '}' in object", this.pos);
          }
        } else {
          if (ch === 0x22) {
            this.skipUnknownString();
            stackState[depthIndex] = STATE_OBJECT_AFTER_KEY;
          } else {
            throw new NewReplyIdentityParseError("expected string key after ',' in object", this.pos);
          }
        }
      }
    }
  }

  private skipUnknownValue(): void {
    this.skipWhitespace();
    if (this.pos >= this.len) {
      throw new NewReplyIdentityParseError("unexpected EOF", this.pos);
    }
    const ch = this.raw.charCodeAt(this.pos);
    if (ch === 0x5b) {
      this.pos++;
      this.skipContainers(CONTAINER_ARRAY);
    } else if (ch === 0x7b) {
      this.pos++;
      this.skipContainers(CONTAINER_OBJECT);
    } else {
      this.skipPrimitive(ch);
    }
  }

  private expectArrayComma(): void {
    this.skipWhitespace();
    if (this.pos >= this.len) {
      throw new NewReplyIdentityParseError("unexpected EOF in array", this.pos);
    }
    if (this.raw.charCodeAt(this.pos) === 0x5d) {
      throw new NewReplyIdentityParseError("invalid length, expected struct Identity with 12 elements", this.pos);
    }
    if (this.raw.charCodeAt(this.pos) !== 0x2c) {
      throw new NewReplyIdentityParseError("expected ',' between array elements", this.pos);
    }
    this.pos++;
  }

  private parseArray(): Identity {
    this.pos++; // skip '['

    this.skipWhitespace();
    if (this.pos < this.len && this.raw.charCodeAt(this.pos) === 0x5d) {
      throw new NewReplyIdentityParseError("invalid length 0, expected struct Identity with 12 elements", this.pos);
    }

    const ingress_id = this.parseStrictString();
    this.expectArrayComma();

    const job_id = this.parseStrictString();
    this.expectArrayComma();

    const thread_id = this.parseStrictString();
    this.expectArrayComma();

    const cwd = this.parseStrictString();
    this.expectArrayComma();

    const state_db = this.parseStrictString();
    this.expectArrayComma();

    const channel_id = this.parseKnownI64();
    this.expectArrayComma();

    const origin_channel_id = this.parseKnownI64();
    this.expectArrayComma();

    const event_id = this.parseOptionalI64();
    this.expectArrayComma();

    const kind = this.parseIngressKind();
    this.expectArrayComma();

    const creation_generation = this.parseKnownI64();
    this.expectArrayComma();

    const prompt_sha256 = this.parseStrictString();
    this.expectArrayComma();

    const acknowledgement = this.parseStrictString();

    this.skipWhitespace();
    if (this.pos >= this.len) {
      throw new NewReplyIdentityParseError("unexpected EOF in array", this.pos);
    }
    if (this.raw.charCodeAt(this.pos) !== 0x5d) {
      if (this.raw.charCodeAt(this.pos) === 0x2c) {
        throw new NewReplyIdentityParseError("trailing characters in array", this.pos);
      }
      throw new NewReplyIdentityParseError("expected ']' at end of Identity array", this.pos);
    }
    this.pos++; // skip ']'

    return {
      ingress_id,
      job_id,
      thread_id,
      cwd,
      state_db,
      channel_id,
      origin_channel_id,
      event_id,
      kind,
      creation_generation,
      prompt_sha256,
      acknowledgement,
    };
  }

  private parseObject(): Identity {
    this.pos++; // skip '{'

    let seen_ingress_id = false;
    let seen_job_id = false;
    let seen_thread_id = false;
    let seen_cwd = false;
    let seen_state_db = false;
    let seen_channel_id = false;
    let seen_origin_channel_id = false;
    let seen_event_id = false;
    let seen_kind = false;
    let seen_creation_generation = false;
    let seen_prompt_sha256 = false;
    let seen_acknowledgement = false;

    let val_ingress_id: string | undefined;
    let val_job_id: string | undefined;
    let val_thread_id: string | undefined;
    let val_cwd: string | undefined;
    let val_state_db: string | undefined;
    let val_channel_id: bigint | undefined;
    let val_origin_channel_id: bigint | undefined;
    let val_event_id: bigint | null = null;
    let val_kind: IngressKind | undefined;
    let val_creation_generation: bigint | undefined;
    let val_prompt_sha256: string | undefined;
    let val_acknowledgement: string | undefined;

    this.skipWhitespace();
    if (this.pos < this.len && this.raw.charCodeAt(this.pos) === 0x7d) {
      this.pos++;
    } else {
      while (true) {
        this.skipWhitespace();
        if (this.pos >= this.len || this.raw.charCodeAt(this.pos) !== 0x22) {
          throw new NewReplyIdentityParseError("expected string key in object", this.pos);
        }
        const key = this.parseStrictString();

        this.skipWhitespace();
        if (this.pos >= this.len || this.raw.charCodeAt(this.pos) !== 0x3a) {
          throw new NewReplyIdentityParseError("expected ':' after object key", this.pos);
        }
        this.pos++;

        switch (key) {
          case "ingress_id":
            if (seen_ingress_id) throw new NewReplyIdentityParseError("duplicate field ingress_id", this.pos);
            seen_ingress_id = true;
            val_ingress_id = this.parseStrictString();
            break;
          case "job_id":
            if (seen_job_id) throw new NewReplyIdentityParseError("duplicate field job_id", this.pos);
            seen_job_id = true;
            val_job_id = this.parseStrictString();
            break;
          case "thread_id":
            if (seen_thread_id) throw new NewReplyIdentityParseError("duplicate field thread_id", this.pos);
            seen_thread_id = true;
            val_thread_id = this.parseStrictString();
            break;
          case "cwd":
            if (seen_cwd) throw new NewReplyIdentityParseError("duplicate field cwd", this.pos);
            seen_cwd = true;
            val_cwd = this.parseStrictString();
            break;
          case "state_db":
            if (seen_state_db) throw new NewReplyIdentityParseError("duplicate field state_db", this.pos);
            seen_state_db = true;
            val_state_db = this.parseStrictString();
            break;
          case "channel_id":
            if (seen_channel_id) throw new NewReplyIdentityParseError("duplicate field channel_id", this.pos);
            seen_channel_id = true;
            val_channel_id = this.parseKnownI64();
            break;
          case "origin_channel_id":
            if (seen_origin_channel_id) throw new NewReplyIdentityParseError("duplicate field origin_channel_id", this.pos);
            seen_origin_channel_id = true;
            val_origin_channel_id = this.parseKnownI64();
            break;
          case "event_id":
            if (seen_event_id) throw new NewReplyIdentityParseError("duplicate field event_id", this.pos);
            seen_event_id = true;
            val_event_id = this.parseOptionalI64();
            break;
          case "kind":
            if (seen_kind) throw new NewReplyIdentityParseError("duplicate field kind", this.pos);
            seen_kind = true;
            val_kind = this.parseIngressKind();
            break;
          case "creation_generation":
            if (seen_creation_generation) throw new NewReplyIdentityParseError("duplicate field creation_generation", this.pos);
            seen_creation_generation = true;
            val_creation_generation = this.parseKnownI64();
            break;
          case "prompt_sha256":
            if (seen_prompt_sha256) throw new NewReplyIdentityParseError("duplicate field prompt_sha256", this.pos);
            seen_prompt_sha256 = true;
            val_prompt_sha256 = this.parseStrictString();
            break;
          case "acknowledgement":
            if (seen_acknowledgement) throw new NewReplyIdentityParseError("duplicate field acknowledgement", this.pos);
            seen_acknowledgement = true;
            val_acknowledgement = this.parseStrictString();
            break;
          default:
            this.skipUnknownValue();
            break;
        }

        this.skipWhitespace();
        if (this.pos >= this.len) {
          throw new NewReplyIdentityParseError("unexpected EOF in object", this.pos);
        }
        if (this.raw.charCodeAt(this.pos) === 0x2c) {
          this.pos++;
          this.skipWhitespace();
          if (this.pos < this.len && this.raw.charCodeAt(this.pos) === 0x7d) {
            throw new NewReplyIdentityParseError("trailing comma in object", this.pos);
          }
        } else if (this.raw.charCodeAt(this.pos) === 0x7d) {
          this.pos++;
          break;
        } else {
          throw new NewReplyIdentityParseError("expected ',' or '}' in object", this.pos);
        }
      }
    }

    if (!seen_ingress_id) throw new NewReplyIdentityParseError("missing field ingress_id", this.pos);
    if (!seen_job_id) throw new NewReplyIdentityParseError("missing field job_id", this.pos);
    if (!seen_thread_id) throw new NewReplyIdentityParseError("missing field thread_id", this.pos);
    if (!seen_cwd) throw new NewReplyIdentityParseError("missing field cwd", this.pos);
    if (!seen_state_db) throw new NewReplyIdentityParseError("missing field state_db", this.pos);
    if (!seen_channel_id) throw new NewReplyIdentityParseError("missing field channel_id", this.pos);
    if (!seen_origin_channel_id) throw new NewReplyIdentityParseError("missing field origin_channel_id", this.pos);
    if (!seen_kind) throw new NewReplyIdentityParseError("missing field kind", this.pos);
    if (!seen_creation_generation) throw new NewReplyIdentityParseError("missing field creation_generation", this.pos);
    if (!seen_prompt_sha256) throw new NewReplyIdentityParseError("missing field prompt_sha256", this.pos);
    if (!seen_acknowledgement) throw new NewReplyIdentityParseError("missing field acknowledgement", this.pos);

    return {
      ingress_id: val_ingress_id!,
      job_id: val_job_id!,
      thread_id: val_thread_id!,
      cwd: val_cwd!,
      state_db: val_state_db!,
      channel_id: val_channel_id!,
      origin_channel_id: val_origin_channel_id!,
      event_id: val_event_id,
      kind: val_kind!,
      creation_generation: val_creation_generation!,
      prompt_sha256: val_prompt_sha256!,
      acknowledgement: val_acknowledgement!,
    };
  }
}

export function parseNewReplyIdentity(raw: string): Identity {
  if (typeof raw !== "string") {
    throw new TypeError("Expected string input");
  }

  if (!isWellFormedUtf16(raw)) {
    throw new NewReplyIdentityParseError("input string contains lone UTF-16 surrogate", 0);
  }

  return new IdentityParser(raw).parse();
}
