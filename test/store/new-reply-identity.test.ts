import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseSerdeValue } from "../../src/core/serde-json-parse.ts";
import {
  parseNewReplyIdentity,
  NewReplyIdentityParseError,
  type Identity,
  type IngressKind,
} from "../../src/store/new-reply-identity.ts";

interface FixtureMetadata {
  type: "metadata";
  metadata: {
    oracle: string;
    serde: string;
    serde_json: string;
    case_count: bigint | number;
  };
}

interface FixtureCaseOk {
  name: string;
  raw: string;
  ok: true;
  identity: Identity;
}

interface FixtureCaseErr {
  name: string;
  raw: string;
  ok: false;
  error: string;
}

type FixtureCase = FixtureCaseOk | FixtureCaseErr;
type FixtureRecord = FixtureMetadata | FixtureCase;

function loadFixture(filename: string): { metadata: FixtureMetadata; cases: FixtureCase[] } {
  const url = new URL(`../fixtures/${filename}`, import.meta.url);
  const content = fs.readFileSync(url, "utf8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    throw new Error(`Fixture ${filename} is empty`);
  }

  const metaLine = lines[0];
  if (!metaLine) {
    throw new Error(`Fixture ${filename} missing first line`);
  }

  const firstRecord = parseSerdeValue<FixtureRecord>(metaLine);
  if (!("type" in firstRecord) || firstRecord.type !== "metadata") {
    throw new Error(`Fixture ${filename} missing metadata header on line 1`);
  }

  const cases: FixtureCase[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parsed = parseSerdeValue<FixtureRecord>(line);
    if ("name" in parsed && typeof parsed.name === "string") {
      cases.push(parsed as FixtureCase);
    } else {
      throw new Error(`Fixture ${filename} line ${i + 1} unexpected record structure`);
    }
  }

  return { metadata: firstRecord, cases };
}

const originalFixture = loadFixture("new-reply-identity-original.ndjson");
const extendedFixture = loadFixture("new-reply-identity-extended.ndjson");

const BASELINE_IDENTITY: Identity = {
  ingress_id: "ing_1",
  job_id: "job_1",
  thread_id: "th_1",
  cwd: "/app",
  state_db: "state.db",
  channel_id: 100n,
  origin_channel_id: 200n,
  event_id: 300n,
  kind: "message",
  creation_generation: 1n,
  prompt_sha256: "abc",
  acknowledgement: "ack_1",
};

const BASELINE_OBJECT_RAW =
  '{"ingress_id":"ing_1","job_id":"job_1","thread_id":"th_1","cwd":"/app","state_db":"state.db","channel_id":100,"origin_channel_id":200,"event_id":300,"kind":"message","creation_generation":1,"prompt_sha256":"abc","acknowledgement":"ack_1"}';

function withExtra(extraKeyAndVal: string): string {
  return BASELINE_OBJECT_RAW.slice(0, -1) + "," + extraKeyAndVal + "}";
}

function replaceField(oldField: string, newField: string): string {
  return BASELINE_OBJECT_RAW.replace(oldField, newField);
}

describe("Fixture integrity, counts, and prefix parity", () => {
  it("validates exact fixture counts and identical prefix between original and extended", () => {
    assert.strictEqual(Number(originalFixture.metadata.metadata.case_count), 58);
    assert.strictEqual(originalFixture.cases.length, 58, "original fixture must contain exactly 58 cases");

    assert.strictEqual(Number(extendedFixture.metadata.metadata.case_count), 161);
    assert.strictEqual(extendedFixture.cases.length, 161, "extended fixture must contain exactly 161 cases");

    for (let i = 0; i < 58; i++) {
      const orig = originalFixture.cases[i];
      const ext = extendedFixture.cases[i];
      assert.ok(orig && ext, `Case at index ${i} must exist in both fixtures`);
      assert.strictEqual(orig.name, ext.name, `Name mismatch at index ${i}`);
      assert.strictEqual(orig.raw, ext.raw, `Raw string mismatch at index ${i}`);
      assert.strictEqual(orig.ok, ext.ok, `Outcome boolean mismatch at index ${i}`);
      if (orig.ok && ext.ok) {
        assert.deepStrictEqual(orig.identity, ext.identity, `Identity mismatch at index ${i}`);
      } else if (!orig.ok && !ext.ok) {
        assert.strictEqual(orig.error, ext.error, `Error string mismatch at index ${i}`);
      }
    }
  });
});

describe("Original 58 oracle test cases", () => {
  for (const c of originalFixture.cases) {
    it(`original: ${c.name}`, () => {
      if (c.ok) {
        const actual = parseNewReplyIdentity(c.raw);
        assert.deepStrictEqual(actual, c.identity);
      } else {
        assert.throws(
          () => parseNewReplyIdentity(c.raw),
          (err: unknown) => err instanceof NewReplyIdentityParseError
        );
      }
    });
  }
});

describe("Extended 161 oracle test cases", () => {
  for (const c of extendedFixture.cases) {
    it(`extended: ${c.name}`, () => {
      if (c.ok) {
        const actual = parseNewReplyIdentity(c.raw);
        assert.deepStrictEqual(actual, c.identity);
      } else {
        assert.throws(
          () => parseNewReplyIdentity(c.raw),
          (err: unknown) => err instanceof NewReplyIdentityParseError
        );
      }
    });
  }
});

describe("Raw JS UTF-16 surrogate checks at input boundary", () => {
  it("rejects non-string raw inputs with TypeError", () => {
    assert.throws(() => parseNewReplyIdentity(null as unknown as string), TypeError);
    assert.throws(() => parseNewReplyIdentity(undefined as unknown as string), TypeError);
    assert.throws(() => parseNewReplyIdentity(12345 as unknown as string), TypeError);
    assert.throws(() => parseNewReplyIdentity({} as unknown as string), TypeError);
  });

  it("rejects lone high surrogate in raw JS input string with position 0", () => {
    const illFormedLeading = "\uD800" + BASELINE_OBJECT_RAW;
    assert.throws(
      () => parseNewReplyIdentity(illFormedLeading),
      (err: unknown) => {
        assert(err instanceof NewReplyIdentityParseError);
        assert.strictEqual(err.position, 0);
        return true;
      }
    );
  });

  it("rejects lone low surrogate in raw JS input string with position 0", () => {
    const illFormedTrailing = BASELINE_OBJECT_RAW + "\uDC00";
    assert.throws(
      () => parseNewReplyIdentity(illFormedTrailing),
      (err: unknown) => {
        assert(err instanceof NewReplyIdentityParseError);
        assert.strictEqual(err.position, 0);
        return true;
      }
    );
  });

  it("rejects embedded lone high surrogate inside a JSON string value", () => {
    const embeddedHigh = replaceField('"job_1"', '"job_\uD800"');
    assert.throws(
      () => parseNewReplyIdentity(embeddedHigh),
      (err: unknown) => {
        assert(err instanceof NewReplyIdentityParseError);
        assert.strictEqual(err.position, 0);
        return true;
      }
    );
  });

  it("rejects embedded lone low surrogate inside a JSON string value", () => {
    const embeddedLow = replaceField('"job_1"', '"job_\uDFFF"');
    assert.throws(
      () => parseNewReplyIdentity(embeddedLow),
      (err: unknown) => {
        assert(err instanceof NewReplyIdentityParseError);
        assert.strictEqual(err.position, 0);
        return true;
      }
    );
  });

  it("rejects reversed surrogate pair in raw JS input string", () => {
    const reversed = replaceField('"job_1"', '"job_\uDC00\uD800"');
    assert.throws(
      () => parseNewReplyIdentity(reversed),
      (err: unknown) => {
        assert(err instanceof NewReplyIdentityParseError);
        assert.strictEqual(err.position, 0);
        return true;
      }
    );
  });

  it("rejects double high surrogate in raw JS input string", () => {
    const doubleHigh = replaceField('"job_1"', '"job_\uD800\uD800"');
    assert.throws(
      () => parseNewReplyIdentity(doubleHigh),
      (err: unknown) => {
        assert(err instanceof NewReplyIdentityParseError);
        assert.strictEqual(err.position, 0);
        return true;
      }
    );
  });

  it("accepts valid raw surrogate pair in known string field", () => {
    const withEmoji = replaceField('"job_1"', '"job_\uD83D\uDE00"');
    const actual = parseNewReplyIdentity(withEmoji);
    assert.deepStrictEqual(actual, {
      ...BASELINE_IDENTITY,
      job_id: "job_😀",
    });
  });

  it("accepts valid raw surrogate pair in unknown key and value", () => {
    const withSurrogateExtra = withExtra('"extra_\uD83E\uDD80":"val_\uD83E\uDD80"');
    const actual = parseNewReplyIdentity(withSurrogateExtra);
    assert.deepStrictEqual(actual, BASELINE_IDENTITY);
  });
});

describe("ASCII four whitespace acceptance and non-JSON whitespace rejection", () => {
  it("accepts valid combinations of the 4 ASCII whitespaces around and within JSON", () => {
    const spaced = `\r\n\t  {\n  "ingress_id" :  "ing_1" ,\r\n  "job_id" :\t"job_1",\n  "thread_id" : "th_1",\n  "cwd" : "/app",\n  "state_db" : "state.db",\n  "channel_id" : 100,\n  "origin_channel_id" : 200,\n  "event_id" : 300,\n  "kind" : "message",\n  "creation_generation" : 1,\n  "prompt_sha256" : "abc",\n  "acknowledgement" : "ack_1"\n}  \t\r\n`;
    const actual = parseNewReplyIdentity(spaced);
    assert.deepStrictEqual(actual, BASELINE_IDENTITY);
  });

  it("accepts 4 ASCII whitespaces in array representation", () => {
    const arraySpaced = `\r\n[\n  "ing_1",\t"job_1",\r\n  "th_1",\n  "/app",\n  "state.db",\n  100,\n  200,\n  300,\n  "message",\n  1,\n  "abc",\n  "ack_1"\n]\t `; 
    const actual = parseNewReplyIdentity(arraySpaced);
    assert.deepStrictEqual(actual, BASELINE_IDENTITY);
  });

  it("rejects non-JSON whitespace: form feed (\f)", () => {
    assert.throws(() => parseNewReplyIdentity("\f" + BASELINE_OBJECT_RAW), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(BASELINE_OBJECT_RAW + "\f"), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('":"ing_1"', '":\f"ing_1"')), NewReplyIdentityParseError);
  });

  it("rejects non-JSON whitespace: vertical tab (\v)", () => {
    assert.throws(() => parseNewReplyIdentity("\v" + BASELINE_OBJECT_RAW), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(BASELINE_OBJECT_RAW + "\v"), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"ing_1",', '"ing_1",\v')), NewReplyIdentityParseError);
  });

  it("rejects non-JSON whitespace: non-breaking space (\u00A0)", () => {
    assert.throws(() => parseNewReplyIdentity("\u00A0" + BASELINE_OBJECT_RAW), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(BASELINE_OBJECT_RAW + "\u00A0"), NewReplyIdentityParseError);
  });

  it("rejects non-JSON whitespace: next line / NEL (\u0085)", () => {
    assert.throws(() => parseNewReplyIdentity("\u0085" + BASELINE_OBJECT_RAW), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(BASELINE_OBJECT_RAW + "\u0085"), NewReplyIdentityParseError);
  });

  it("rejects non-JSON whitespace: zero-width space (\u200B)", () => {
    assert.throws(() => parseNewReplyIdentity("\u200B" + BASELINE_OBJECT_RAW), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(BASELINE_OBJECT_RAW + "\u200B"), NewReplyIdentityParseError);
  });

  it("rejects non-JSON whitespace: ideographic space (\u3000)", () => {
    assert.throws(() => parseNewReplyIdentity("\u3000" + BASELINE_OBJECT_RAW), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(BASELINE_OBJECT_RAW + "\u3000"), NewReplyIdentityParseError);
  });
});

describe("Escaped duplicate known fields including first null", () => {
  it("accepts single escaped known field names", () => {
    const escapedIngress = replaceField('"ingress_id":', '"\\u0069ngress_id":');
    const actual = parseNewReplyIdentity(escapedIngress);
    assert.deepStrictEqual(actual, BASELINE_IDENTITY);
  });

  it("rejects duplicate known fields when second key is escaped", () => {
    const dup = replaceField('"job_id":"job_1"', '"job_id":"job_1","\\u006aob_id":"job_2"');
    assert.throws(() => parseNewReplyIdentity(dup), (err: unknown) => {
      assert(err instanceof NewReplyIdentityParseError);
      return true;
    });
  });

  it("rejects duplicate known fields when first key is escaped and second is literal", () => {
    const dup = replaceField('"job_id":"job_1"', '"\\u006aob_id":"job_1","job_id":"job_2"');
    assert.throws(() => parseNewReplyIdentity(dup), NewReplyIdentityParseError);
  });

  it("rejects duplicate known fields when both keys are escaped", () => {
    const dup = replaceField('"job_id":"job_1"', '"\\u006aob_id":"job_1","\\u006aob_id":"job_2"');
    assert.throws(() => parseNewReplyIdentity(dup), NewReplyIdentityParseError);
  });

  it("rejects duplicate channel_id with escaped key", () => {
    const dup = replaceField('"channel_id":100', '"channel_id":100,"\\u0063hannel_id":200');
    assert.throws(() => parseNewReplyIdentity(dup), NewReplyIdentityParseError);
  });

  it("rejects duplicate event_id when first is escaped null and second is literal number", () => {
    const dup = replaceField('"event_id":300', '"\\u0065vent_id":null,"event_id":400');
    assert.throws(() => parseNewReplyIdentity(dup), NewReplyIdentityParseError);
  });

  it("rejects duplicate event_id when first is literal null and second is escaped null", () => {
    const dup = replaceField('"event_id":300', '"event_id":null,"\\u0065vent_id":null');
    assert.throws(() => parseNewReplyIdentity(dup), NewReplyIdentityParseError);
  });

  it("rejects duplicate event_id when first is escaped number and second is literal null", () => {
    const dup = replaceField('"event_id":300', '"\\u0065vent_id":300,"event_id":null');
    assert.throws(() => parseNewReplyIdentity(dup), NewReplyIdentityParseError);
  });

  it("rejects duplicate event_id when both are escaped (some then null)", () => {
    const dup = replaceField('"event_id":300', '"\\u0065vent_id":300,"\\u0065vent_id":null');
    assert.throws(() => parseNewReplyIdentity(dup), NewReplyIdentityParseError);
  });
});

describe("IngressKind enum matrix", () => {
  it("accepts each valid variant as null-payload object", () => {
    const msgObj = replaceField('"kind":"message"', '"kind":{"message":null}');
    assert.deepStrictEqual(parseNewReplyIdentity(msgObj), {
      ...BASELINE_IDENTITY,
      kind: "message",
    });

    const interObj = replaceField('"kind":"message"', '"kind":{"interaction":null}');
    assert.deepStrictEqual(parseNewReplyIdentity(interObj), {
      ...BASELINE_IDENTITY,
      kind: "interaction",
    });

    const actObj = replaceField('"kind":"message"', '"kind":{"action":null}');
    assert.deepStrictEqual(parseNewReplyIdentity(actObj), {
      ...BASELINE_IDENTITY,
      kind: "action",
    });
  });

  it("accepts escaped variant keys in null-payload object form", () => {
    const escMsg = replaceField('"kind":"message"', '"kind":{"\\u006dessage":null}');
    assert.deepStrictEqual(parseNewReplyIdentity(escMsg), BASELINE_IDENTITY);
  });

  it("rejects empty object for IngressKind", () => {
    const emptyObj = replaceField('"kind":"message"', '"kind":{}');
    assert.throws(() => parseNewReplyIdentity(emptyObj), NewReplyIdentityParseError);
  });

  it("rejects duplicate variant keys in IngressKind object", () => {
    const dupKind = replaceField('"kind":"message"', '"kind":{"message":null,"message":null}');
    assert.throws(() => parseNewReplyIdentity(dupKind), NewReplyIdentityParseError);
  });

  it("rejects multiple different variant keys in IngressKind object", () => {
    const multiKind = replaceField('"kind":"message"', '"kind":{"message":null,"action":null}');
    assert.throws(() => parseNewReplyIdentity(multiKind), NewReplyIdentityParseError);
  });

  it("rejects unknown variant key in IngressKind object", () => {
    const unknownKind = replaceField('"kind":"message"', '"kind":{"unknown_variant":null}');
    assert.throws(() => parseNewReplyIdentity(unknownKind), NewReplyIdentityParseError);
  });

  it("rejects non-null payloads for IngressKind variant object", () => {
    assert.throws(() => parseNewReplyIdentity(replaceField('"kind":"message"', '"kind":{"message":123}')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"kind":"message"', '"kind":{"message":"invalid"}')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"kind":"message"', '"kind":{"message":true}')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"kind":"message"', '"kind":{"message":[]}')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"kind":"message"', '"kind":{"message":{}}')), NewReplyIdentityParseError);
  });
});

describe("Unknown nested containers, bracket mismatches, trailing commas, and invalid escapes", () => {
  it("rejects trailing comma in unknown nested array", () => {
    const raw = withExtra('"extra":[1,2,]');
    assert.throws(() => parseNewReplyIdentity(raw), NewReplyIdentityParseError);
  });

  it("rejects trailing comma in unknown nested object", () => {
    const raw = withExtra('"extra":{"a":1,}');
    assert.throws(() => parseNewReplyIdentity(raw), NewReplyIdentityParseError);
  });

  it("rejects mismatched bracket in unknown containers", () => {
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":[1,2}')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":{"a":1]')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":{"arr":[1,2}}')), NewReplyIdentityParseError);
  });

  it("rejects unclosed unknown containers at EOF", () => {
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":[1,2')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":{"a":1')), NewReplyIdentityParseError);
  });

  it("rejects invalid escapes in unknown strings", () => {
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":"invalid \\z escape"')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":"invalid \\u000G hex"')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":"short \\u12 hex"')), NewReplyIdentityParseError);
  });

  it("rejects unescaped control characters in unknown strings", () => {
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":"unescaped\x00null"')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":"unescaped\x1fctrl"')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":"unescaped\trawtab"')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":"unescaped\nrawnewline"')), NewReplyIdentityParseError);
  });

  it("rejects malformed numbers in unknown values", () => {
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":1e+')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":1e-')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":012')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":1.')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":.5')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(withExtra('"extra":-')), NewReplyIdentityParseError);
  });
});

describe("Direct vs nested ignored keys and surrogate acceptance parity", () => {
  it("rejects direct top-level unknown key with escaped lone high surrogate", () => {
    const raw = withExtra('"\\uD800":"val"');
    assert.throws(() => parseNewReplyIdentity(raw), NewReplyIdentityParseError);
  });

  it("rejects direct top-level unknown key with escaped lone low surrogate", () => {
    const raw = withExtra('"\\uDFFF":"val"');
    assert.throws(() => parseNewReplyIdentity(raw), NewReplyIdentityParseError);
  });

  it("accepts nested unknown key with escaped lone high surrogate", () => {
    const raw = withExtra('"extra":{"\\uD800":"val"}');
    const actual = parseNewReplyIdentity(raw);
    assert.deepStrictEqual(actual, BASELINE_IDENTITY);
  });

  it("accepts nested unknown key with escaped lone low surrogate", () => {
    const raw = withExtra('"extra":{"\\uDFFF":"val"}');
    const actual = parseNewReplyIdentity(raw);
    assert.deepStrictEqual(actual, BASELINE_IDENTITY);
  });

  it("accepts direct top-level unknown key with valid escaped surrogate pair", () => {
    const raw = withExtra('"\\uD83D\\uDE00":"val"');
    const actual = parseNewReplyIdentity(raw);
    assert.deepStrictEqual(actual, BASELINE_IDENTITY);
  });
});

describe("Unknown 1e999 and escaped isolated surrogate acceptance parity", () => {
  it("accepts unknown 1e999 and -1e999", () => {
    assert.deepStrictEqual(parseNewReplyIdentity(withExtra('"extra":1e999')), BASELINE_IDENTITY);
    assert.deepStrictEqual(parseNewReplyIdentity(withExtra('"extra":-1e999')), BASELINE_IDENTITY);
  });

  it("rejects known numeric fields given 1e999", () => {
    assert.throws(() => parseNewReplyIdentity(replaceField('"channel_id":100', '"channel_id":1e999')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"origin_channel_id":200', '"origin_channel_id":1e999')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"event_id":300', '"event_id":1e999')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"creation_generation":1', '"creation_generation":1e999')), NewReplyIdentityParseError);
  });

  it("rejects known string fields given 1e999", () => {
    assert.throws(() => parseNewReplyIdentity(replaceField('"ingress_id":"ing_1"', '"ingress_id":1e999')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"job_id":"job_1"', '"job_id":1e999')), NewReplyIdentityParseError);
  });

  it("accepts unknown string with escaped isolated surrogate", () => {
    assert.deepStrictEqual(parseNewReplyIdentity(withExtra('"extra":"\\uD800"')), BASELINE_IDENTITY);
    assert.deepStrictEqual(parseNewReplyIdentity(withExtra('"extra":"\\uDFFF"')), BASELINE_IDENTITY);
  });

  it("rejects known string fields given escaped isolated surrogate", () => {
    assert.throws(() => parseNewReplyIdentity(replaceField('"ingress_id":"ing_1"', '"ingress_id":"\\uD800"')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"ingress_id":"ing_1"', '"ingress_id":"\\uDFFF"')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"job_id":"job_1"', '"job_id":"\\uD800"')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"prompt_sha256":"abc"', '"prompt_sha256":"\\uD800"')), NewReplyIdentityParseError);
  });
});

describe("Unknown very deep iterative containers without stack overflow", () => {
  it("parses depth 4096 array without stack overflow", () => {
    const deepArray = "[".repeat(4096) + "1" + "]".repeat(4096);
    const raw = withExtra(`"deep":${deepArray}`);
    const actual = parseNewReplyIdentity(raw);
    assert.deepStrictEqual(actual, BASELINE_IDENTITY);
  });

  it("parses depth 4096 object without stack overflow (~25k chars)", () => {
    const deepObject = '{"k":'.repeat(4096) + "1" + "}".repeat(4096);
    const raw = withExtra(`"deep":${deepObject}`);
    const actual = parseNewReplyIdentity(raw);
    assert.deepStrictEqual(actual, BASELINE_IDENTITY);
  });

  it("rejects malformed deep container: missing closing bracket at depth 4096", () => {
    const unclosedArray = "[".repeat(4096) + "1" + "]".repeat(4095);
    const raw = withExtra(`"deep":${unclosedArray}`);
    assert.throws(() => parseNewReplyIdentity(raw), NewReplyIdentityParseError);
  });

  it("rejects malformed deep container: trailing comma at depth 100", () => {
    const commaDeep = "[".repeat(100) + "1," + "]".repeat(100);
    const raw = withExtra(`"deep":${commaDeep}`);
    assert.throws(() => parseNewReplyIdentity(raw), NewReplyIdentityParseError);
  });
});

describe("Prototype pollution and property integrity checks", () => {
  it("ensures __proto__ and constructor keys do not pollute Object.prototype or alter result prototype", () => {
    const payload = withExtra('"__proto__":{"polluted":"yes"},"constructor":{"polluted":"yes"}');
    const actual = parseNewReplyIdentity(payload);

    assert.deepStrictEqual(actual, BASELINE_IDENTITY);

    assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
    assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
    assert.strictEqual("polluted" in {}, false);

    assert.strictEqual(Object.getPrototypeOf(actual), Object.prototype);

    assert.strictEqual(Object.prototype.hasOwnProperty.call(actual, "polluted"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(actual, "__proto__"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(actual, "constructor"), false);
  });
});

describe("Strict i64 boundaries, leading zeros, and array representation", () => {
  it("accepts 0 for channel_id but rejects leading zeros and -0", () => {
    const zero = replaceField('"channel_id":100', '"channel_id":0');
    assert.strictEqual(parseNewReplyIdentity(zero).channel_id, 0n);

    const leadingZero = replaceField('"channel_id":100', '"channel_id":01');
    assert.throws(() => parseNewReplyIdentity(leadingZero), NewReplyIdentityParseError);

    const negZero = replaceField('"channel_id":100', '"channel_id":-0');
    assert.throws(() => parseNewReplyIdentity(negZero), NewReplyIdentityParseError);
  });

  it("accepts exact i64 boundary extremes and rejects 1 beyond", () => {
    const maxOk = replaceField('"channel_id":100', '"channel_id":9223372036854775807');
    assert.strictEqual(parseNewReplyIdentity(maxOk).channel_id, 9223372036854775807n);

    const minOk = replaceField('"channel_id":100', '"channel_id":-9223372036854775808');
    assert.strictEqual(parseNewReplyIdentity(minOk).channel_id, -9223372036854775808n);

    const overflow = replaceField('"channel_id":100', '"channel_id":9223372036854775808');
    assert.throws(() => parseNewReplyIdentity(overflow), NewReplyIdentityParseError);

    const underflow = replaceField('"channel_id":100', '"channel_id":-9223372036854775809');
    assert.throws(() => parseNewReplyIdentity(underflow), NewReplyIdentityParseError);
  });

  it("rejects floating point values for known i64 fields", () => {
    assert.throws(() => parseNewReplyIdentity(replaceField('"channel_id":100', '"channel_id":1.0')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"origin_channel_id":200', '"origin_channel_id":1e0')), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity(replaceField('"creation_generation":1', '"creation_generation":1.5')), NewReplyIdentityParseError);
  });

  it("rejects truncated, oversized, or trailing-comma array representations", () => {
    assert.throws(() => parseNewReplyIdentity("[]"), NewReplyIdentityParseError);
    assert.throws(() => parseNewReplyIdentity('["ing_1","job_1"]'), NewReplyIdentityParseError);
    assert.throws(
      () => parseNewReplyIdentity('["ing_1","job_1","th_1","/app","state.db",100,200,300,"message",1,"abc"]'),
      NewReplyIdentityParseError
    );
    assert.throws(
      () => parseNewReplyIdentity('["ing_1","job_1","th_1","/app","state.db",100,200,300,"message",1,"abc","ack_1","extra"]'),
      NewReplyIdentityParseError
    );
    assert.throws(
      () => parseNewReplyIdentity('["ing_1","job_1","th_1","/app","state.db",100,200,300,"message",1,"abc","ack_1",]'),
      NewReplyIdentityParseError
    );
  });
});
