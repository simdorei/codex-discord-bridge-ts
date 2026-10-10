import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AdmissionGate } from "../../src/admission/drain-gate.ts";
import type { DrainFenceKeyRecord } from "../../src/admission/owned-key.ts";

const BASE_GATE_SHA256 = "ae4efc9f482dda3183944ca1ed4bab0e185a122c4c01081687e0b70345c0f7dc";
const BASE_KEY_SHA256 = "864fa8ed7d51888503868e8ee0e07f4b3a4017f39d665b88dcaca762b9a7e6a8";

export const INSTRUMENTATION_INSERTION = `
// __AGY_INSTRUMENTATION_APPENDED_INSERTION__
export interface TestGateInternalState {
  active: bigint;
  sealedRecord: DrainFenceKeyRecord | null;
  controlsOpen: boolean;
  poisoned: boolean;
  notifications: bigint;
}

export function __inspectGateInternal(gate: AdmissionGate): TestGateInternalState {
  return getGateState(gate);
}

export function __patchGateInternal(
  gate: AdmissionGate,
  patch: Partial<TestGateInternalState>,
): void {
  const state = getGateState(gate);
  if (patch.active !== undefined) state.active = patch.active;
  if (patch.sealedRecord !== undefined) state.sealedRecord = patch.sealedRecord;
  if (patch.controlsOpen !== undefined) state.controlsOpen = patch.controlsOpen;
  if (patch.poisoned !== undefined) state.poisoned = patch.poisoned;
  if (patch.notifications !== undefined) state.notifications = patch.notifications;
}
`;

interface MirrorModule {
  AdmissionGate: typeof AdmissionGate;
  AdmissionPermit: new (...args: any[]) => any;
  DrainFenceKey: {
    create(runtimeId: unknown, processIdentity: unknown, nonce: unknown): any;
  };
  DrainGateError: new (kind: string) => Error & { kind: string };
  MAX_COUNT: bigint;
  __inspectGateInternal(gate: unknown): {
    active: bigint;
    sealedRecord: DrainFenceKeyRecord | null;
    controlsOpen: boolean;
    poisoned: boolean;
    notifications: bigint;
  };
  __patchGateInternal(
    gate: unknown,
    patch: Partial<{
      active: bigint;
      sealedRecord: DrainFenceKeyRecord | null;
      controlsOpen: boolean;
      poisoned: boolean;
      notifications: bigint;
    }>,
  ): void;
}

describe("Instrumented Drain Gate Mirror Suite", () => {
  let tmpRoot: string;
  let fixtureDir: string;
  let realFixtureDir = "";
  let mirror: MirrorModule;

  before(async () => {
    tmpRoot = await fs.promises.realpath(os.tmpdir());
    fixtureDir = await fs.promises.mkdtemp(path.join(tmpRoot, "drain-gate-fixture-"));
    realFixtureDir = await fs.promises.realpath(fixtureDir);

    assert.equal(path.dirname(realFixtureDir), tmpRoot);
    assert.notEqual(realFixtureDir, tmpRoot);

    const gatePath = path.resolve(
      fileURLToPath(new URL("../../src/admission/drain-gate.ts", import.meta.url)),
    );
    const keyPath = path.resolve(
      fileURLToPath(new URL("../../src/admission/owned-key.ts", import.meta.url)),
    );

    const gateSource = await fs.promises.readFile(gatePath, "utf8");
    const keySource = await fs.promises.readFile(keyPath, "utf8");

    const gateSha = crypto.createHash("sha256").update(gateSource).digest("hex");
    const keySha = crypto.createHash("sha256").update(keySource).digest("hex");
    assert.equal(gateSha, BASE_GATE_SHA256);
    assert.equal(keySha, BASE_KEY_SHA256);

    const instrumentedSource = gateSource + INSTRUMENTATION_INSERTION;
    assert.equal(instrumentedSource.endsWith(INSTRUMENTATION_INSERTION), true);
    const strippedSource = instrumentedSource.slice(0, -INSTRUMENTATION_INSERTION.length);
    assert.equal(strippedSource, gateSource);
    const strippedSha = crypto.createHash("sha256").update(strippedSource).digest("hex");
    assert.equal(strippedSha, BASE_GATE_SHA256);

    const fixtureAdmissionDir = path.join(realFixtureDir, "src", "admission");
    await fs.promises.mkdir(fixtureAdmissionDir, { recursive: true });

    await fs.promises.writeFile(
      path.join(fixtureAdmissionDir, "owned-key.ts"),
      keySource,
      "utf8",
    );
    await fs.promises.writeFile(
      path.join(fixtureAdmissionDir, "drain-gate.ts"),
      gateSource,
      "utf8",
    );
    const instrumentedPath = path.join(
      fixtureAdmissionDir,
      "drain-gate-instrumented.ts",
    );
    await fs.promises.writeFile(instrumentedPath, instrumentedSource, "utf8");

    mirror = (await import(pathToFileURL(instrumentedPath).href)) as unknown as MirrorModule;
  });

  after(async () => {
    const current = await fs.promises.realpath(fixtureDir);
    assert.equal(current.toLowerCase(), realFixtureDir.toLowerCase());
    assert.equal(path.dirname(current), tmpRoot);
    assert.notEqual(realFixtureDir, tmpRoot);
    await fs.promises.rm(realFixtureDir, { recursive: true, force: true });
  });

  it("verifies fixture classes are distinct from production classes", () => {
    assert.notEqual(mirror.AdmissionGate, AdmissionGate);
  });

  it("verifies mirror and sibling module identity and separate weakmaps", async () => {
    const fixtureAdmissionDir = path.join(realFixtureDir, "src", "admission");
    const copiedKeyModule = (await import(
      pathToFileURL(path.join(fixtureAdmissionDir, "owned-key.ts")).href
    )) as unknown as { DrainFenceKey: MirrorModule["DrainFenceKey"] };
    const unmodifiedGateModule = (await import(
      pathToFileURL(path.join(fixtureAdmissionDir, "drain-gate.ts")).href
    )) as unknown as {
      AdmissionGate: typeof AdmissionGate;
      DrainFenceKey: MirrorModule["DrainFenceKey"];
    };
    const mirrorModule = (await import(
      pathToFileURL(path.join(fixtureAdmissionDir, "drain-gate-instrumented.ts")).href
    )) as unknown as MirrorModule;

    assert.equal(unmodifiedGateModule.DrainFenceKey, copiedKeyModule.DrainFenceKey);
    assert.equal(mirrorModule.DrainFenceKey, copiedKeyModule.DrainFenceKey);
    assert.equal(mirror.DrainFenceKey, copiedKeyModule.DrainFenceKey);

    assert.notEqual(mirrorModule.AdmissionGate, AdmissionGate);
    assert.notEqual(unmodifiedGateModule.AdmissionGate, AdmissionGate);
    assert.notEqual(mirrorModule.AdmissionGate, unmodifiedGateModule.AdmissionGate);

    const key = copiedKeyModule.DrainFenceKey.create("rt1", "10|20", "n1");
    const mirrorGate = new mirrorModule.AdmissionGate();
    const unmodifiedGate = new unmodifiedGateModule.AdmissionGate();

    mirrorGate.seal(key);
    assert.equal(mirrorGate.isSealed(), true);
    assert.equal(unmodifiedGate.isSealed(), false);

    unmodifiedGate.seal(key);
    assert.equal(unmodifiedGate.isSealed(), true);

    assert.throws(() => mirrorModule.__inspectGateInternal(unmodifiedGate as any));
  });

  it("rejects admission at MAX_COUNT without mutating healthy flag or poisoning gate", () => {
    const gate = new mirror.AdmissionGate();
    mirror.__patchGateInternal(gate, { active: mirror.MAX_COUNT });
    assert.throws(
      () => gate.tryEnter(),
      (err: unknown) => err instanceof mirror.DrainGateError && err.kind === "LockPoisoned",
    );
    assert.throws(
      () => gate.tryEnterControl(),
      (err: unknown) => err instanceof mirror.DrainGateError && err.kind === "LockPoisoned",
    );
    const state = mirror.__inspectGateInternal(gate);
    assert.equal(state.active, mirror.MAX_COUNT);
    assert.equal(state.poisoned, false);
  });

  it("allows permit clone under poison without incrementing active count or notifications", () => {
    const gate = new mirror.AdmissionGate();
    const permit = gate.tryEnter();
    const state = mirror.__inspectGateInternal(gate);
    assert.equal(state.active, 1n);
    mirror.__patchGateInternal(gate, { poisoned: true });
    const notifsBefore = state.notifications;
    const clone = permit.clone();
    assert.equal(clone instanceof mirror.AdmissionPermit, true);
    assert.equal(state.active, 1n);
    assert.equal(state.notifications, notifsBefore);
  });

  it("prioritizes DisposedHandle error over poison check on permit clone", () => {
    const gate = new mirror.AdmissionGate();
    const permit = gate.tryEnter();
    permit.release();
    mirror.__patchGateInternal(gate, { poisoned: true });
    assert.throws(
      () => permit.clone(),
      (err: unknown) => err instanceof mirror.DrainGateError && err.kind === "DisposedHandle",
    );
  });

  it("marks permit disposed on first release under poison and skips notification", () => {
    const gate = new mirror.AdmissionGate();
    const permit = gate.tryEnter();
    const state = mirror.__inspectGateInternal(gate);
    mirror.__patchGateInternal(gate, { poisoned: true });
    const notifsBefore = state.notifications;
    const activeBefore = state.active;
    permit.release();
    assert.equal(state.active, activeBefore);
    assert.equal(state.notifications, notifsBefore);
    assert.throws(
      () => permit.clone(),
      (err: unknown) => err instanceof mirror.DrainGateError && err.kind === "DisposedHandle",
    );
    permit.release();
    assert.equal(state.notifications, notifsBefore);
  });

  it("notifies when saturating decrement reaches zero from 0n active count", () => {
    const gate = new mirror.AdmissionGate();
    const permit = gate.tryEnter();
    const state = mirror.__inspectGateInternal(gate);
    mirror.__patchGateInternal(gate, { active: 0n });
    const notifsBefore = state.notifications;
    permit.release();
    assert.equal(state.active, 0n);
    assert.equal(state.notifications, notifsBefore + 1n);
  });

  it("increments notifications on same-key seal and unchanged control toggles", () => {
    const gate = new mirror.AdmissionGate();
    const key = mirror.DrainFenceKey.create("rt1", "10|20", "n1");
    const state = mirror.__inspectGateInternal(gate);
    assert.equal(state.notifications, 0n);
    gate.seal(key);
    assert.equal(state.notifications, 1n);
    gate.seal(key);
    assert.equal(state.notifications, 2n);
    gate.openControls(key);
    assert.equal(state.notifications, 3n);
    gate.openControls(key);
    assert.equal(state.notifications, 4n);
    gate.closeControls(key);
    assert.equal(state.notifications, 5n);
    gate.closeControls(key);
    assert.equal(state.notifications, 6n);
  });

  it("does not increment notifications on entry, clone, repeated dispose, failures, or poison", () => {
    const gate = new mirror.AdmissionGate();
    const key = mirror.DrainFenceKey.create("rt1", "10|20", "n1");
    const wrongKey = mirror.DrainFenceKey.create("rt2", "10|20", "n1");
    const state = mirror.__inspectGateInternal(gate);
    assert.equal(state.notifications, 0n);
    const p1 = gate.tryEnter();
    assert.equal(state.notifications, 0n);
    const pControl = gate.tryEnterControl();
    assert.equal(state.notifications, 0n);
    const pClone = p1.clone();
    assert.equal(state.notifications, 0n);
    p1.release();
    assert.equal(state.notifications, 0n);
    p1.release();
    assert.equal(state.notifications, 0n);
    assert.throws(() => gate.seal({} as any));
    assert.equal(state.notifications, 0n);
    assert.throws(() => gate.closeControls(wrongKey));
    assert.equal(state.notifications, 0n);
    assert.throws(() => gate.openControls(wrongKey));
    assert.equal(state.notifications, 0n);
    assert.equal(gate.release(wrongKey), false);
    assert.equal(state.notifications, 0n);
    mirror.__patchGateInternal(gate, { poisoned: true });
    assert.throws(() => gate.tryEnter());
    assert.throws(() => gate.tryEnterControl());
    assert.throws(() => gate.seal(key));
    assert.throws(() => gate.closeControls(key));
    assert.throws(() => gate.openControls(key));
    assert.equal(gate.isSealed(), true);
    assert.equal(gate.isDrainedFor(key), false);
    assert.equal(gate.release(key), false);
    assert.equal(state.notifications, 0n);
    pControl.release();
    pClone.release();
  });

  it("mirror: saturates active count at MAX_COUNT on clone without wrap, keeps healthy, and disposes with decrement", () => {
    const gate = new mirror.AdmissionGate();
    const permit = gate.tryEnter();
    mirror.__patchGateInternal(gate, { active: mirror.MAX_COUNT });
    const notifsBefore = mirror.__inspectGateInternal(gate).notifications;

    const clone = permit.clone();
    assert.equal(clone instanceof mirror.AdmissionPermit, true);
    const stateAtMax = mirror.__inspectGateInternal(gate);
    assert.equal(stateAtMax.active, mirror.MAX_COUNT);
    assert.equal(stateAtMax.notifications, notifsBefore);
    assert.equal(stateAtMax.poisoned, false);

    assert.throws(
      () => gate.tryEnter(),
      (err: unknown) => err instanceof mirror.DrainGateError && err.kind === "LockPoisoned",
    );
    assert.throws(
      () => gate.tryEnterControl(),
      (err: unknown) => err instanceof mirror.DrainGateError && err.kind === "LockPoisoned",
    );

    clone.dispose();
    assert.equal(mirror.__inspectGateInternal(gate).active, mirror.MAX_COUNT - 1n);
    permit.dispose();
    assert.equal(mirror.__inspectGateInternal(gate).active, mirror.MAX_COUNT - 2n);
  });

  it("mirror: gives poison precedence over foreign traps and revoked proxies with zero hooks", () => {
    const gate = new mirror.AdmissionGate();
    mirror.__patchGateInternal(gate, { poisoned: true });

    let trapped = false;
    const foreign = new Proxy(
      {},
      {
        get() {
          trapped = true;
          throw new Error("trap get");
        },
        has() {
          trapped = true;
          throw new Error("trap has");
        },
      },
    );
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();

    for (const bad of [foreign, revoked]) {
      trapped = false;
      for (const op of [
        (g: typeof gate) => g.seal(bad),
        (g: typeof gate) => g.openControls(bad),
        (g: typeof gate) => g.closeControls(bad),
      ]) {
        assert.throws(
          () => op(gate),
          (err: unknown) =>
            err instanceof mirror.DrainGateError &&
            err.kind === "LockPoisoned" &&
            err.message === "restart admission gate lock is poisoned",
        );
      }
      assert.equal(gate.isDrainedFor(bad), false);
      assert.equal(gate.release(bad), false);
      assert.equal(trapped, false);
    }
  });

  it("mirror: verifies same-key reseal preserves closed controls and release lifecycle with exact counts", () => {
    const gate = new mirror.AdmissionGate();
    const k1 = mirror.DrainFenceKey.create("rt1", "10|20", "n1");
    const k2 = mirror.DrainFenceKey.create("rt1", "10|20", "n1");

    gate.seal(k1);
    const state = mirror.__inspectGateInternal(gate);
    assert.equal(state.notifications, 1n);
    assert.equal(state.controlsOpen, true);

    gate.closeControls(k1);
    assert.equal(state.notifications, 2n);
    assert.equal(state.controlsOpen, false);
    assert.throws(
      () => gate.tryEnterControl(),
      (err: unknown) => err instanceof mirror.DrainGateError && err.kind === "Sealed",
    );

    gate.seal(k1);
    assert.equal(state.notifications, 3n);
    assert.equal(state.controlsOpen, false);
    assert.throws(
      () => gate.tryEnterControl(),
      (err: unknown) => err instanceof mirror.DrainGateError && err.kind === "Sealed",
    );

    assert.equal(gate.release(k2), true);
    assert.equal(state.notifications, 4n);
    assert.equal(state.sealedRecord, null);
    assert.equal(state.controlsOpen, false);

    assert.equal(gate.release(k2), false);
    assert.equal(gate.release(k1), false);
    assert.equal(state.notifications, 4n);
  });
});
