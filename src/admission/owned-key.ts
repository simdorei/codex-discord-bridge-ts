export type DrainGateErrorKind =
  | "InvalidKey"
  | "Sealed"
  | "FenceMismatch"
  | "LockPoisoned"
  | "DisposedHandle";

function getErrorMessage(kind: DrainGateErrorKind): string {
  switch (kind) {
    case "InvalidKey":
      return "restart drain key is malformed";
    case "Sealed":
      return "restart admission is sealed; retry after the runtime restarts";
    case "FenceMismatch":
      return "restart drain fence does not match the active runtime and nonce";
    case "LockPoisoned":
      return "restart admission gate lock is poisoned";
    case "DisposedHandle":
      return "Cannot clone a disposed AdmissionPermit";
  }
}

export class DrainGateError extends Error {
  readonly kind: DrainGateErrorKind;

  constructor(kind: DrainGateErrorKind) {
    super(getErrorMessage(kind));
    this.kind = kind;
    this.name = "DrainGateError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface DrainFenceKeyRecord {
  readonly runtimeId: string;
  readonly processIdentity: string;
  readonly nonce: string;
}

const RUNTIME_ID_RE = /^[0-9A-Za-z_-]{1,128}$/;
const PROCESS_IDENTITY_RE = /^[0-9]+\|[0-9]+$/;
const NONCE_RE = /^[0-9A-Za-z_-]{1,128}$/;

const OWNED_KEY_BRAND = new WeakSet<object>();
const KEY_RECORDS = new WeakMap<object, DrainFenceKeyRecord>();
const CONSTRUCTOR_TOKEN = Symbol("DrainFenceKeyToken");

export class DrainFenceKey {
  readonly #runtimeId: string;
  readonly #processIdentity: string;
  readonly #nonce: string;

  /** @internal */
  constructor(token: unknown, record: DrainFenceKeyRecord) {
    if (token !== CONSTRUCTOR_TOKEN) {
      throw new DrainGateError("InvalidKey");
    }
    this.#runtimeId = record.runtimeId;
    this.#processIdentity = record.processIdentity;
    this.#nonce = record.nonce;
  }

  static create(
    runtimeId: unknown,
    processIdentity: unknown,
    nonce: unknown,
  ): DrainFenceKey {
    if (
      typeof runtimeId !== "string" ||
      typeof processIdentity !== "string" ||
      typeof nonce !== "string"
    ) {
      throw new DrainGateError("InvalidKey");
    }

    if (
      !RUNTIME_ID_RE.test(runtimeId) ||
      !PROCESS_IDENTITY_RE.test(processIdentity) ||
      !NONCE_RE.test(nonce)
    ) {
      throw new DrainGateError("InvalidKey");
    }

    const record: DrainFenceKeyRecord = Object.freeze({
      runtimeId,
      processIdentity,
      nonce,
    });

    const key = new DrainFenceKey(CONSTRUCTOR_TOKEN, record);
    OWNED_KEY_BRAND.add(key);
    KEY_RECORDS.set(key, record);
    return key;
  }

  get runtimeId(): string {
    return this.#runtimeId;
  }

  get processIdentity(): string {
    return this.#processIdentity;
  }

  get nonce(): string {
    return this.#nonce;
  }

  equals(other: unknown): boolean {
    const thisRec = getDrainFenceKeyRecord(this);
    const otherRec = getDrainFenceKeyRecord(other);
    if (thisRec === null || otherRec === null) {
      return false;
    }
    return areKeyRecordsEqual(thisRec, otherRec);
  }
}

export function getDrainFenceKeyRecord(key: unknown): DrainFenceKeyRecord | null {
  if ((typeof key !== "object" && typeof key !== "function") || key === null) {
    return null;
  }
  try {
    if (!OWNED_KEY_BRAND.has(key)) {
      return null;
    }
    return KEY_RECORDS.get(key) ?? null;
  } catch {
    return null;
  }
}

export function areKeyRecordsEqual(
  a: DrainFenceKeyRecord,
  b: DrainFenceKeyRecord,
): boolean {
  return (
    a.runtimeId === b.runtimeId &&
    a.processIdentity === b.processIdentity &&
    a.nonce === b.nonce
  );
}
