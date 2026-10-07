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
      state.notifications += 1n;
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

  tryEnterControl(): AdmissionPermit {
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
    return new AdmissionPermit(PERMIT_TOKEN, this);
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
      state.notifications += 1n;
    } else if (areKeyRecordsEqual(state.sealedRecord, record)) {
      state.notifications += 1n;
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
    state.notifications += 1n;
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
    state.notifications += 1n;
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
    state.notifications += 1n;
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
