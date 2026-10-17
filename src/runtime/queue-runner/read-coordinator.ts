import { StateAccessFacade } from "../../store/state-access-facade.ts";
import type { IStateAccessFacade } from "../../store/state-access-facade.ts";
import { TargetLocks } from "./target-locks.ts";

export interface QueueReadBackend {
  activeTurnId(target: string, signal?: AbortSignal): Promise<string | null>;
}

export interface BusyStatus { readonly busy: boolean; readonly allowSteer: boolean; }
type QueueReads = Pick<IStateAccessFacade, "listFiltered" | "eligibleJobs">;

/** Read-side coordinator; share `locks` with subsequent mutation/recovery paths. */
export class QueueReadCoordinator {
  readonly path: string;
  readonly backend: QueueReadBackend;
  readonly state: QueueReads;
  readonly locks: TargetLocks;
  constructor(
    path: string, backend: QueueReadBackend,
    state: QueueReads = StateAccessFacade, locks: TargetLocks = new TargetLocks(),
  ) {
    this.path = path; this.backend = backend; this.state = state; this.locks = locks;
  }

  busyStatus(target: string, signal?: AbortSignal): Promise<BusyStatus> {
    return this.locks.run(target, async () => {
      signal?.throwIfAborted();
      const active = await this.backend.activeTurnId(target, signal) !== null;
      signal?.throwIfAborted();
      const jobs = await this.state.listFiltered(this.path, target, null);
      const eligible = await this.state.eligibleJobs(this.path, jobs);
      signal?.throwIfAborted();
      return {busy: active || eligible.some(job => job.state !== "Quarantined"), allowSteer: active};
    }, signal);
  }

  /** Rust performs this evidence read without the target mutex or hold filtering. */
  async controlBinding(target: string): Promise<readonly [string | null, string | null]> {
    const active = await this.backend.activeTurnId(target);
    if (active !== null) return [active, null];
    const jobs = await this.state.listFiltered(this.path, target, null);
    const candidates = jobs.filter(job =>
      (job.state === "Starting" || job.state === "Running") && !job.goalWaiting);
    const only = candidates.length === 1 ? candidates[0] : undefined;
    return only === undefined ? [null, null] : [only.turnId, only.jobId];
  }
}
