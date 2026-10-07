import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import test, { describe, it } from "node:test";
import { windowsNativePathToStringLossy } from "../../src/core/windows-native-path.ts";

interface ObservationRow {
  id: string;
  platform: string;
  units?: number[];
  bytes?: number[];
  host_os: string;
  status: string;
  roundtrip_code_units?: number[];
  lossy_string?: string;
  lossy_utf8_hex?: string;
  lossy_scalar_codepoints?: number[];
  seed_json?: string;
}

describe("windowsNativePathToStringLossy", () => {
  it("matches observed Rust native oracle observations across all Windows rows", () => {
    const fixtureUrl = new URL("../fixtures/windows-native-path-observed.ndjson", import.meta.url);
    const content = fs.readFileSync(fixtureUrl, "utf8");
    const rows: ObservationRow[] = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as ObservationRow);

    assert.strictEqual(rows.length, 43, "Fixture must contain exactly 43 rows");

    const windowsRows = rows.filter(
      (r) => r.status === "observed" && r.platform === "windows-utf16" && r.host_os === "windows"
    );
    assert.strictEqual(windowsRows.length, 32, "Must contain exactly 32 observed Windows rows");

    const unixRows = rows.filter((r) => r.platform === "unix-bytes");
    assert.strictEqual(unixRows.length, 11, "Must contain exactly 11 unobserved Unix rows");

    for (const u of unixRows) {
      assert.strictEqual(u.status, "not-observed-on-this-platform");
      assert.strictEqual(u.lossy_string, undefined);
      assert.strictEqual(u.lossy_utf8_hex, undefined);
      assert.strictEqual(u.lossy_scalar_codepoints, undefined);
      assert.strictEqual(u.seed_json, undefined);
    }

    const bomLeading = windowsRows.find((r) => r.id === "win-bom-leading");
    assert.ok(bomLeading, "win-bom-leading must exist in observed Windows rows");
    const bomBetweenNul = windowsRows.find((r) => r.id === "win-bom-between-nul");
    assert.ok(bomBetweenNul, "win-bom-between-nul must exist in observed Windows rows");

    for (const row of windowsRows) {
      assert.ok(row.units !== undefined, `units missing for ${row.id}`);
      assert.ok(row.lossy_string !== undefined, `lossy_string missing for ${row.id}`);
      assert.ok(row.lossy_utf8_hex !== undefined, `lossy_utf8_hex missing for ${row.id}`);
      assert.ok(row.lossy_scalar_codepoints !== undefined, `lossy_scalar_codepoints missing for ${row.id}`);

      const actualLossy = windowsNativePathToStringLossy({
        platform: "windows-utf16",
        units: row.units,
      });

      assert.strictEqual(actualLossy, row.lossy_string, `lossy string mismatch for ${row.id}`);

      const actualHex = Buffer.from(actualLossy, "utf8").toString("hex");
      assert.strictEqual(actualHex, row.lossy_utf8_hex, `UTF-8 hex mismatch for ${row.id}`);

      const actualCodepoints = Array.from(actualLossy).map((c) => c.codePointAt(0)!);
      assert.deepStrictEqual(
        actualCodepoints,
        row.lossy_scalar_codepoints,
        `scalar codepoint mismatch for ${row.id}`
      );
    }
  });

  it("enforces boundary guards without invoking user getters, setters, or traps", () => {
    let getTrap = 0;
    let descTrap = 0;
    let ownKeysTrap = 0;
    const proxyInput = new Proxy(
      { platform: "windows-utf16", units: [65] },
      {
        get(_target, prop) {
          getTrap++;
          return Reflect.get(_target, prop);
        },
        getOwnPropertyDescriptor(_target, prop) {
          descTrap++;
          return Reflect.getOwnPropertyDescriptor(_target, prop);
        },
        ownKeys(_target) {
          ownKeysTrap++;
          return Reflect.ownKeys(_target);
        },
      }
    );
    assert.throws(() => windowsNativePathToStringLossy(proxyInput), TypeError);
    assert.strictEqual(getTrap, 0);
    assert.strictEqual(descTrap, 0);
    assert.strictEqual(ownKeysTrap, 0);

    let unitsGetTrap = 0;
    let unitsDescTrap = 0;
    const proxyUnits = new Proxy([65], {
      get(_target, prop) {
        unitsGetTrap++;
        return Reflect.get(_target, prop);
      },
      getOwnPropertyDescriptor(_target, prop) {
        unitsDescTrap++;
        return Reflect.getOwnPropertyDescriptor(_target, prop);
      },
    });
    assert.throws(
      () => windowsNativePathToStringLossy({ platform: "windows-utf16", units: proxyUnits }),
      TypeError
    );
    assert.strictEqual(unitsGetTrap, 0);
    assert.strictEqual(unitsDescTrap, 0);

    let getterCount = 0;
    const getterObj = {
      get platform() {
        getterCount++;
        return "windows-utf16";
      },
      units: [65],
    };
    assert.throws(() => windowsNativePathToStringLossy(getterObj), TypeError);
    assert.strictEqual(getterCount, 0);

    let setterCount = 0;
    const setterObj = {
      platform: "windows-utf16",
      set units(_v: unknown) {
        setterCount++;
      },
    };
    assert.throws(() => windowsNativePathToStringLossy(setterObj), TypeError);
    assert.strictEqual(setterCount, 0);
  });

  it("does not execute iterators, toString, or map on array input", () => {
    let iterCount = 0;
    let toStringCount = 0;
    const origIter = Array.prototype[Symbol.iterator];
    const origToString = Array.prototype.toString;
    try {
      Array.prototype[Symbol.iterator] = function () {
        iterCount++;
        return origIter.call(this);
      };
      Array.prototype.toString = function () {
        toStringCount++;
        return origToString.call(this);
      };

      const result = windowsNativePathToStringLossy({
        platform: "windows-utf16",
        units: [65, 66],
      });
      assert.strictEqual(result, "AB");
      assert.strictEqual(iterCount, 0);
      assert.strictEqual(toStringCount, 0);
    } finally {
      Array.prototype[Symbol.iterator] = origIter;
      Array.prototype.toString = origToString;
    }
  });

  it("rejects malformed units, invalid types, -0, and extra properties", () => {
    assert.throws(() => windowsNativePathToStringLossy({ platform: "windows-utf16", units: [-0] }), TypeError);
    assert.throws(() => windowsNativePathToStringLossy({ platform: "windows-utf16", units: [-1] }), TypeError);
    assert.throws(() => windowsNativePathToStringLossy({ platform: "windows-utf16", units: [65536] }), TypeError);
    assert.throws(() => windowsNativePathToStringLossy({ platform: "windows-utf16", units: [1.5] }), TypeError);
    assert.throws(() => windowsNativePathToStringLossy({ platform: "windows-utf16", units: [NaN] }), TypeError);
    assert.throws(() => windowsNativePathToStringLossy({ platform: "windows-utf16", units: [Infinity] }), TypeError);
    assert.throws(() => windowsNativePathToStringLossy({ platform: "windows-utf16", units: ["65" as unknown as number] }), TypeError);
    assert.throws(() => windowsNativePathToStringLossy({ platform: "windows-utf16", units: [65n as unknown as number] }), TypeError);

    const holeArr = new Array(2);
    holeArr[0] = 65;
    assert.throws(() => windowsNativePathToStringLossy({ platform: "windows-utf16", units: holeArr }), TypeError);

    const extraPropUnits = [65];
    (extraPropUnits as unknown as { extra: number }).extra = 1;
    assert.throws(() => windowsNativePathToStringLossy({ platform: "windows-utf16", units: extraPropUnits }), TypeError);

    const symPropUnits = [65];
    (symPropUnits as unknown as { [sym: symbol]: number })[Symbol("extra")] = 1;
    assert.throws(() => windowsNativePathToStringLossy({ platform: "windows-utf16", units: symPropUnits }), TypeError);

    assert.throws(
      () => windowsNativePathToStringLossy({ platform: "windows-utf16", units: [65], extra: 1 }),
      TypeError
    );
    assert.throws(
      () => windowsNativePathToStringLossy({ platform: "windows-utf16", units: [65], [Symbol("extra")]: 1 }),
      TypeError
    );
    assert.throws(
      () => windowsNativePathToStringLossy({ platform: "unix-bytes", bytes: [65] }),
      TypeError
    );
    assert.throws(() => windowsNativePathToStringLossy(null), TypeError);
    assert.throws(() => windowsNativePathToStringLossy("C:\\path"), TypeError);
    assert.throws(() => windowsNativePathToStringLossy([65]), TypeError);
  });

  it("accepts frozen records, frozen arrays, and null-prototype records without mutation", () => {
    const frozen = Object.freeze({
      platform: "windows-utf16" as const,
      units: Object.freeze([67, 58, 92]),
    });
    assert.strictEqual(windowsNativePathToStringLossy(frozen), "C:\\");

    const nullProto = Object.create(null) as { platform: "windows-utf16"; units: number[] };
    nullProto.platform = "windows-utf16";
    nullProto.units = [65, 66];
    assert.strictEqual(windowsNativePathToStringLossy(nullProto), "AB");

    const inputUnits = [65, 66, 67];
    const inputObj = { platform: "windows-utf16" as const, units: inputUnits };
    assert.strictEqual(windowsNativePathToStringLossy(inputObj), "ABC");
    assert.deepStrictEqual(inputUnits, [65, 66, 67]);
    assert.strictEqual(inputUnits.length, 3);
  });

  it("handles large ~70K unit arrays without spread or stack overflow", () => {
    const count = 70000;
    const largeUnits = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      largeUnits[i] = 97;
    }
    const res = windowsNativePathToStringLossy({
      platform: "windows-utf16",
      units: largeUnits,
    });
    assert.strictEqual(res.length, count);
    assert.strictEqual(res, "a".repeat(count));
  });

  it("correctly replaces lone surrogates using code-unit integer fixtures", () => {
    assert.strictEqual(windowsNativePathToStringLossy({ platform: "windows-utf16", units: [55296] }), "\uFFFD");
    assert.strictEqual(windowsNativePathToStringLossy({ platform: "windows-utf16", units: [56320] }), "\uFFFD");
    assert.strictEqual(
      windowsNativePathToStringLossy({ platform: "windows-utf16", units: [55296, 56320] }),
      String.fromCodePoint(65536)
    );
  });
});
