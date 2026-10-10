import {
  DrainFenceKey,
  DrainGateError,
  type DrainGateErrorKind,
  type DrainFenceKeyRecord,
  getDrainFenceKeyRecord,
  areKeyRecordsEqual,
} from "./owned-key.ts";

export { DrainGateError, type DrainGateErrorKind, DrainFenceKey };

export const MAX_COUNT = 18446744073709551615n;

interface GateInternalState {
  active: bigint;
  sealedRecord: DrainFenceKeyRecord | null;
  controlsOpen: boolean;
  poisoned: boolean;
  notifications: bigint;
  readonly waiters: Set<() => void>;
}

const GATE_STATES = new WeakMap<AdmissionGate, GateInternalState>();
const PERMIT_TOKEN = Symbol("AdmissionPermitToken");

export class AdmissionPermit {
  readonly #gate: AdmissionGate;
  #disposed: boolean = false;

  /** @internal */
  constructor(token: unknown, gate: AdmissionGate) {
    if (token !== PERMIT_TOKEN) {
      throw new DrainGateError("InvalidKey");
    }
    this.#gate = gate;
  }

  clone(): AdmissionPermit {
    if (this.#disposed) {
      throw new DrainGateError("DisposedHandle");
    }

    const state = getGateState(this.#gate);
    if (state.poisoned) {
      return new AdmissionPermit(PERMIT_TOKEN, this.#gate);
    }

    state.active = state.active < MAX_COUNT ? state.active + 1n : MAX_COUNT;
    return new AdmissionPermit(PERMIT_TOKEN, this.#gate);
  }

  release(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    const state = getGateState(this.#gate);
    if (state.poisoned) {
      return;
    }

    state.active = state.active > 0n ? state.active - 1n : 0n;
    if (state.active === 0n) {
      notifyGate(state);
    }
  }

  dispose(): void {
    this.release();
  }
}

export class AdmissionGate {
  constructor() {
    GATE_STATES.set(this, {
      active: 0n,
      sealedRecord: null,
      controlsOpen: false,
      poisoned: false,
      notifications: 0n,
      waiters: new Set(),
    });
  }

  tryEnter(): AdmissionPermit {
    const state = getGateState(this);
    if (state.poisoned) {
      throw new DrainGateError("LockPoisoned");
    }
    if (state.sealedRecord !== null) {
      throw new DrainGateError("Sealed");
    }
    if (state.active === MAX_COUNT) {
      throw new DrainGateError("LockPoisoned");
    }
    state.active += 1n;
    return new AdmissionPermit(PERMIT_TOKEN, this);
  }

  tryEnterControl(): AdmissionPermit {return this.tryEnterControlObserved()[0];}

  /** One synchronous snapshot of control admission and restart-draining state. */
  tryEnterControlObserved(): readonly [AdmissionPermit,boolean] {
    const state = getGateState(this);
    if (state.poisoned) {
      throw new DrainGateError("LockPoisoned");
    }
    if (state.sealedRecord !== null && !state.controlsOpen) {
      throw new DrainGateError("Sealed");
    }
    if (state.active === MAX_COUNT) {
      throw new DrainGateError("LockPoisoned");
    }
    state.active += 1n;
    return [new AdmissionPermit(PERMIT_TOKEN, this),state.sealedRecord!==null] as const;
  }

  seal(key: unknown): void {
    const state = getGateState(this);
    if (state.poisoned) {
      throw new DrainGateError("LockPoisoned");
    }
    const record = getDrainFenceKeyRecord(key);
    if (record === null) {
      throw new DrainGateError("FenceMismatch");
    }
    if (state.sealedRecord === null) {
      state.sealedRecord = {
        runtimeId: record.runtimeId,
        processIdentity: record.processIdentity,
        nonce: record.nonce,
      };
      state.controlsOpen = true;
      notifyGate(state);
    } else if (areKeyRecordsEqual(state.sealedRecord, record)) {
      notifyGate(state);
    } else {
      throw new DrainGateError("FenceMismatch");
    }
  }

  closeControls(key: unknown): void {
    const state = getGateState(this);
    if (state.poisoned) {
      throw new DrainGateError("LockPoisoned");
    }
    const record = getDrainFenceKeyRecord(key);
    if (record === null) {
      throw new DrainGateError("FenceMismatch");
    }
    if (
      state.sealedRecord === null ||
      !areKeyRecordsEqual(state.sealedRecord, record)
    ) {
      throw new DrainGateError("FenceMismatch");
    }
    state.controlsOpen = false;
    notifyGate(state);
  }

  openControls(key: unknown): void {
    const state = getGateState(this);
    if (state.poisoned) {
      throw new DrainGateError("LockPoisoned");
    }
    const record = getDrainFenceKeyRecord(key);
    if (record === null) {
      throw new DrainGateError("FenceMismatch");
    }
    if (
      state.sealedRecord === null ||
      !areKeyRecordsEqual(state.sealedRecord, record)
    ) {
      throw new DrainGateError("FenceMismatch");
    }
    state.controlsOpen = true;
    notifyGate(state);
  }

  isSealed(): boolean {
    const state = getGateState(this);
    return state.poisoned || state.sealedRecord !== null;
  }

  isDrainedFor(key: unknown): boolean {
    const state = getGateState(this);
    if (state.poisoned) {
      return false;
    }
    const record = getDrainFenceKeyRecord(key);
    if (record === null) {
      return false;
    }
    if (state.active !== 0n || state.sealedRecord === null) {
      return false;
    }
    return areKeyRecordsEqual(state.sealedRecord, record);
  }

  /** No polling: each release/seal/control notification wakes current waiters.
   * The deadline is monotonic and never restarted by a notification. Abort removes
   * only this waiter, not another caller's permit or the sealed fence. */
  async waitDrained(key: unknown, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError("Expected nonnegative safe drain timeout");
    const record = getDrainFenceKeyRecord(key);
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      signal?.throwIfAborted();
      const state = getGateState(this);
      if (state.poisoned) throw new DrainGateError("LockPoisoned");
      if (record === null || state.sealedRecord === null || !areKeyRecordsEqual(state.sealedRecord, record)) throw new DrainGateError("FenceMismatch");
      if (state.active === 0n) return;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new AdmissionDrainTimeoutError(timeoutMs);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (aborted: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          state.waiters.delete(wake);
          signal?.removeEventListener("abort", abort);
          if (aborted) reject(signal!.reason); else resolve();
        };
        const wake = () => finish(false), abort = () => finish(true);
        const timer = setTimeout(wake, Math.min(remaining, 2147483647));
        state.waiters.add(wake);
        signal?.addEventListener("abort", abort, {once: true});
        if (signal?.aborted) abort();
      });
    }
  }

  release(key: unknown): boolean {
    const state = getGateState(this);
    if (state.poisoned) {
      return false;
    }
    if (state.active !== 0n) {
      return false;
    }
    const record = getDrainFenceKeyRecord(key);
    if (record === null) {
      return false;
    }
    if (state.sealedRecord === null) {
      return false;
    }
    if (!areKeyRecordsEqual(state.sealedRecord, record)) {
      return false;
    }
    state.sealedRecord = null;
    state.controlsOpen = false;
    notifyGate(state);
    return true;
  }
}

function getGateState(gate: AdmissionGate): GateInternalState {
  const state = GATE_STATES.get(gate);
  if (!state) {
    throw new DrainGateError("LockPoisoned");
  }
  return state;
}

/** Rust Timeout is represented separately from the existing synchronous gate
 * error class, preserving its constructor-owned classifier contract. */
export class AdmissionDrainTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`restart admission drain timed out after ${timeoutMs} ms`);
    this.name = "AdmissionDrainTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
function notifyGate(state: GateInternalState): void {
  state.notifications += 1n;
  for (const wake of [...state.waiters]) wake();
}
