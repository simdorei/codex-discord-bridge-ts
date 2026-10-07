import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AdmissionGate,
  AdmissionPermit,
  DrainFenceKey,
  DrainGateError,
  MAX_COUNT,
} from "../../src/admission/drain-gate.ts";
import {
  type DrainGateErrorKind,
  getDrainFenceKeyRecord,
} from "../../src/admission/owned-key.ts";

describe("Production Drain Gate Black-Box Suite", () => {
  describe("DrainGateError Closed Error Kinds and Messages", () => {
    const errorCases: ReadonlyArray<readonly [DrainGateErrorKind, string]> = [
      ["InvalidKey", "restart drain key is malformed"],
      ["Sealed", "restart admission is sealed; retry after the runtime restarts"],
      ["FenceMismatch", "restart drain fence does not match the active runtime and nonce"],
      ["LockPoisoned", "restart admission gate lock is poisoned"],
      ["DisposedHandle", "Cannot clone a disposed AdmissionPermit"],
    ];

    for (const [kind, expectedMessage] of errorCases) {
      it(`instantiates ${kind} with exact message`, () => {
        const error = new DrainGateError(kind);
        assert.equal(error instanceof Error, true);
        assert.equal(error instanceof DrainGateError, true);
        assert.equal(error.name, "DrainGateError");
        assert.equal(error.kind, kind);
        assert.equal(error.message, expectedMessage);
      });
    }

    it("rejects direct AdmissionPermit construction without internal token", () => {
      const gate = new AdmissionGate();
      assert.throws(
        () => new AdmissionPermit(null, gate),
        (err: unknown) => err instanceof DrainGateError && err.kind === "InvalidKey",
      );
    });
  });

  describe("DrainFenceKey Factory and Primitive-Only Validation", () => {
    const validRuntime = "prod_worker-01";
    const validPid = "1044|50012";
    const validNonce = "nonce_abc123-xyz";

    it("creates key with valid ASCII components and exposes immutable getters", () => {
      const key = DrainFenceKey.create(validRuntime, validPid, validNonce);
      assert.equal(key.runtimeId, validRuntime);
      assert.equal(key.processIdentity, validPid);
      assert.equal(key.nonce, validNonce);
    });

    it("rejects non-string argument types without coercion", () => {
      const nonStrings: readonly unknown[] = [
        123,
        true,
        null,
        undefined,
        {},
        Symbol("id"),
        100n,
      ];
      for (const val of nonStrings) {
        assert.throws(
          () => DrainFenceKey.create(val, validPid, validNonce),
          (err: unknown) => err instanceof DrainGateError && err.kind === "InvalidKey",
        );
        assert.throws(
          () => DrainFenceKey.create(validRuntime, val, validNonce),
          (err: unknown) => err instanceof DrainGateError && err.kind === "InvalidKey",
        );
        assert.throws(
          () => DrainFenceKey.create(validRuntime, validPid, val),
          (err: unknown) => err instanceof DrainGateError && err.kind === "InvalidKey",
        );
      }
    });

    it("rejects malformed grammar patterns", () => {
      const badRuntimes = ["", "invalid char", "bad@id", "a".repeat(129)];
      for (const r of badRuntimes) {
        assert.throws(
          () => DrainFenceKey.create(r, validPid, validNonce),
          (err: unknown) => err instanceof DrainGateError && err.kind === "InvalidKey",
        );
      }

      const badPids = ["", "pid", "1044", "1044|", "|50012", "1044|abc", "-1|2"];
      for (const p of badPids) {
        assert.throws(
          () => DrainFenceKey.create(validRuntime, p, validNonce),
          (err: unknown) => err instanceof DrainGateError && err.kind === "InvalidKey",
        );
      }

      const badNonces = ["", "invalid nonce", "bad#nonce", "n".repeat(129)];
      for (const n of badNonces) {
        assert.throws(
          () => DrainFenceKey.create(validRuntime, validPid, n),
          (err: unknown) => err instanceof DrainGateError && err.kind === "InvalidKey",
        );
      }
    });

    it("rejects hostile objects and revoked proxies across all arguments without invoking traps", () => {
      let trapped = false;
      const hostile = new Proxy(
        {
          toString() {
            trapped = true;
            return "";
          },
          valueOf() {
            trapped = true;
            return "";
          },
        },
        {
          get(_t, p) {
            trapped = true;
            throw new Error(`trap get: ${String(p)}`);
          },
          has() {
            trapped = true;
            throw new Error("trap has");
          },
        },
      );
      const { proxy: revoked, revoke } = Proxy.revocable({}, {});
      revoke();

      for (const bad of [hostile, revoked]) {
        trapped = false;
        for (const args of [
          [bad, validPid, validNonce],
          [validRuntime, bad, validNonce],
          [validRuntime, validPid, bad],
        ]) {
          assert.throws(
            () => DrainFenceKey.create(args[0], args[1], args[2]),
            (err: unknown) =>
              err instanceof DrainGateError &&
              err.kind === "InvalidKey" &&
              err.message === "restart drain key is malformed",
          );
        }
        assert.equal(trapped, false);
      }
    });
  });

  describe("DrainFenceKey Value Equality and Method Tampering", () => {
    it("matches distinct factory instances with identical values", () => {
      const key1 = DrainFenceKey.create("rt1", "12|34", "nonceA");
      const key2 = DrainFenceKey.create("rt1", "12|34", "nonceA");
      const keyDiff = DrainFenceKey.create("rt2", "12|34", "nonceA");

      assert.equal(key1.equals(key2), true);
      assert.equal(key2.equals(key1), true);
      assert.equal(key1.equals(keyDiff), false);
      assert.equal(key1.equals(null), false);
      assert.equal(key1.equals({}), false);
    });

    it("ignores mutated public equals method during gate operations", () => {
      const key1 = DrainFenceKey.create("rt1", "12|34", "nonceA");
      const key2 = DrainFenceKey.create("rt1", "12|34", "nonceA");
      (key1 as unknown as { equals: () => boolean }).equals = () => false;

      const gate = new AdmissionGate();
      gate.seal(key1);
      assert.equal(gate.isDrainedFor(key2), true);
      assert.equal(gate.release(key2), true);
    });

    it("exposes frozen key record resisting mutation while preserving original values", () => {
      const key = DrainFenceKey.create("rt1", "12|34", "nonceA");
      const record = getDrainFenceKeyRecord(key);
      assert.notEqual(record, null);
      assert.equal(Object.isFrozen(record), true);
      assert.equal(Reflect.set(record as object, "runtimeId", "tampered"), false);
      assert.throws(() => {
        (record as unknown as { runtimeId: string }).runtimeId = "tampered";
      }, TypeError);
      assert.equal(key.runtimeId, "rt1");
      assert.equal(key.processIdentity, "12|34");
      assert.equal(key.nonce, "nonceA");

      const keySame = DrainFenceKey.create("rt1", "12|34", "nonceA");
      (key as unknown as { equals: unknown }).equals = undefined;
      assert.throws(() => {
        (key as unknown as { runtimeId: string }).runtimeId = "tampered";
      }, TypeError);
      assert.equal(key.runtimeId, "rt1");

      const gate = new AdmissionGate();
      gate.seal(key);
      assert.equal(gate.isDrainedFor(keySame), true);
      assert.equal(gate.release(keySame), true);
    });
  });

  describe("Zero-Hook Brand Lookup and Revoked Proxy Handling", () => {
    it("handles revoked proxies without throwing TypeError or invoking hooks", () => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();

      const gate = new AdmissionGate();
      assert.equal(gate.isDrainedFor(proxy), false);
      assert.equal(gate.release(proxy), false);

      assert.throws(
        () => gate.seal(proxy),
        (err: unknown) => err instanceof DrainGateError && err.kind === "FenceMismatch",
      );
      assert.throws(
        () => gate.closeControls(proxy),
        (err: unknown) => err instanceof DrainGateError && err.kind === "FenceMismatch",
      );
      assert.throws(
        () => gate.openControls(proxy),
        (err: unknown) => err instanceof DrainGateError && err.kind === "FenceMismatch",
      );
    });

    it("does not trigger property getters or prototype traps on foreign objects", () => {
      let trapped = false;
      const foreign = new Proxy(
        { runtimeId: "rt1", processIdentity: "12|34", nonce: "nonceA" },
        {
          get() {
            trapped = true;
            throw new Error("Foreign getter invoked");
          },
          has() {
            trapped = true;
            throw new Error("Foreign has invoked");
          },
        },
      );

      const gate = new AdmissionGate();
      assert.equal(gate.isDrainedFor(foreign), false);
      assert.equal(gate.release(foreign), false);
      assert.throws(
        () => gate.seal(foreign),
        (err: unknown) => err instanceof DrainGateError && err.kind === "FenceMismatch",
      );
      assert.equal(trapped, false);
    });
  });

  describe("AdmissionGate and AdmissionPermit Lifecycle", () => {
    it("exercises admission, controls, sealing, and idempotent permit release", () => {
      const gate = new AdmissionGate();
      assert.equal(gate.isSealed(), false);

      const p1 = gate.tryEnter();
      const pControl = gate.tryEnterControl();
      const pClone = p1.clone();

      p1.release();
      p1.release();
      p1.dispose();

      assert.throws(
        () => p1.clone(),
        (err: unknown) =>
          err instanceof DrainGateError &&
          err.kind === "DisposedHandle" &&
          err.message === "Cannot clone a disposed AdmissionPermit",
      );

      const keyA = DrainFenceKey.create("rt1", "10|20", "n1");
      const keyA2 = DrainFenceKey.create("rt1", "10|20", "n1");
      const keyB = DrainFenceKey.create("rt2", "10|20", "n1");

      gate.seal(keyA);
      assert.equal(gate.isSealed(), true);

      assert.throws(
        () => gate.tryEnter(),
        (err: unknown) => err instanceof DrainGateError && err.kind === "Sealed",
      );

      const pControl2 = gate.tryEnterControl();
      gate.seal(keyA2);

      assert.throws(
        () => gate.seal(keyB),
        (err: unknown) => err instanceof DrainGateError && err.kind === "FenceMismatch",
      );

      gate.closeControls(keyA2);
      assert.throws(
        () => gate.tryEnterControl(),
        (err: unknown) => err instanceof DrainGateError && err.kind === "Sealed",
      );

      gate.closeControls(keyA);
      gate.seal(keyA);
      assert.throws(
        () => gate.tryEnterControl(),
        (err: unknown) => err instanceof DrainGateError && err.kind === "Sealed",
      );
      gate.openControls(keyA);
      const pControl3 = gate.tryEnterControl();

      assert.equal(gate.isDrainedFor(keyA), false);
      assert.equal(gate.release(keyA), false);

      pControl.release();
      pClone.release();
      pControl2.release();
      pControl3.release();

      assert.equal(gate.isDrainedFor(keyA), true);
      assert.equal(gate.isDrainedFor(keyA2), true);
      assert.equal(gate.isDrainedFor(keyB), false);

      assert.equal(gate.release(keyB), false);
      assert.equal(gate.release(keyA2), true);
      assert.equal(gate.isSealed(), false);
      assert.equal(gate.release(keyA2), false);
      assert.equal(gate.release(keyA), false);

      const pNew = gate.tryEnter();
      pNew.release();
    });

    it("verifies MAX_COUNT constant definition", () => {
      assert.equal(MAX_COUNT, 18446744073709551615n);
    });
  });
});
