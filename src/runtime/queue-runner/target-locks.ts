/** One registry per coordinator; normal work and non-waiting leases share it. */
export interface TargetLease {
  readonly target: string;
  requireTarget(target: string): void;
  release(): void;
}

export class TargetLeaseMismatchError extends Error {
  readonly kind = "InvalidQueueState";
  constructor() { super("queue target lease mismatch"); this.name = "TargetLeaseMismatchError"; }
}

interface Entry { held: boolean; waiters: Waiter[]; }
interface Waiter { grant(): void; }

function validateTarget(target: string): void {
  if (typeof target !== "string" || /[\uD800-\uDFFF]/u.test(target)) {
    throw new TypeError("Expected a well-formed target string");
  }
}

/** Event-loop-local FIFO mutexes, not cross-process or distributed locks. */
export class TargetLocks {
  readonly #entries = new Map<string, Entry>();

  get activeTargetCount(): number { return this.#entries.size; }

  tryAcquire(target: string): TargetLease | undefined {
    validateTarget(target);
    let entry = this.#entries.get(target);
    if (entry?.held) return undefined;
    if (entry === undefined) {
      entry = {held: true, waiters: []};
      this.#entries.set(target, entry);
    } else entry.held = true;
    return this.#lease(target, entry);
  }

  /** Cancellation removes a queued waiter; it never releases another owner. */
  acquire(target: string, signal?: AbortSignal): Promise<TargetLease> {
    validateTarget(target);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const available = this.tryAcquire(target);
    if (available !== undefined) return Promise.resolve(available);
    const entry = this.#entries.get(target)!;
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = (): void => {
        if (settled) return;
        settled = true;
        const index = entry.waiters.indexOf(waiter);
        if (index !== -1) entry.waiters.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
      };
      const waiter: Waiter = {grant: () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve(this.#lease(target, entry));
      }};
      entry.waiters.push(waiter);
      signal?.addEventListener("abort", abort, {once: true});
    });
  }

  async run<T>(target: string, work: (lease: TargetLease) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    const lease = await this.acquire(target, signal);
    try { return await work(lease); } finally { lease.release(); }
  }

  /** Acquire a pair in one global order. Caller must first release any separately held target lease. */
  async runPair<T>(left: string, right: string, work: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    validateTarget(left); validateTarget(right);
    const targets = [...new Set([left, right])].sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const leases: TargetLease[] = [];
    try {
      for (const target of targets) leases.push(await this.acquire(target, signal));
      return await work();
    } finally {
      for (let index=leases.length-1; index>=0; index--) leases[index]!.release();
    }
  }

  #lease(target: string, entry: Entry): TargetLease {
    let released = false;
    return Object.freeze({
      target,
      requireTarget(expected: string): void {
        if (released || expected !== target) throw new TargetLeaseMismatchError();
      },
      release: (): void => {
        if (released) return;
        released = true;
        const next = entry.waiters.shift();
        if (next !== undefined) next.grant();
        else {
          entry.held = false;
          if (this.#entries.get(target) === entry) this.#entries.delete(target);
        }
      },
    });
  }
}
