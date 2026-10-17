import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

type Native = (...args: any[]) => any;
interface Api {create: Native; open: Native; current: Native; assign: Native; limits: Native; query: Native; terminate: Native; close: Native; error: Native;}
let cached: Api | undefined;
const retained = new Set<WindowsProcessJob>();
export class WindowsProcessJobError extends Error {
  constructor(readonly operation: string, readonly lastError: number | null = null) {
    super(`Windows process ownership failed (${operation}${lastError === null ? '' : `/${lastError}`})`);
    this.name = 'WindowsProcessJobError';
  }
}
function api(): Api {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw new WindowsProcessJobError('platform');
  if (cached !== undefined) return cached;
  const koffi = createRequire(import.meta.url)('koffi') as {version: string; load(name: string): {func(declaration: string): Native}};
  if (koffi.version !== '3.3.3') throw new WindowsProcessJobError('dependency-version');
  const library = koffi.load('kernel32.dll');
  cached = {
    create: library.func('void * __stdcall CreateJobObjectW(void *attributes, str16 name)'),
    open: library.func('void * __stdcall OpenJobObjectW(uint32_t access, int32_t inherit, str16 name)'),
    current: library.func('void * __stdcall GetCurrentProcess(void)'),
    assign: library.func('int32_t __stdcall AssignProcessToJobObject(void *job, void *process)'),
    limits: library.func('int32_t __stdcall SetInformationJobObject(void *job, int32_t kind, void *data, uint32_t size)'),
    query: library.func('int32_t __stdcall QueryInformationJobObject(void *job, int32_t kind, void *data, uint32_t size, void *returned)'),
    terminate: library.func('int32_t __stdcall TerminateJobObject(void *job, uint32_t exitCode)'),
    close: library.func('int32_t __stdcall CloseHandle(void *handle)'),
    error: library.func('uint32_t __stdcall GetLastError(void)'),
  };
  return cached;
}
function valid(handle: unknown): handle is bigint { return typeof handle === 'bigint' && handle !== 0n; }
function requireBool(value: unknown, operation: string, binding: Api): void {
  if (value === 0) throw new WindowsProcessJobError(operation, binding.error() as number);
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new WindowsProcessJobError(operation);
}

/** The parent is the sole long-lived job handle owner. A bootstrap child joins
 * this job before it can launch Codex, then closes its temporary job handle.
 * Parent death therefore kills Codex and descendants without a PID-based kill. */
export class WindowsProcessJob {
  readonly name: string;
  readonly #api: Api;
  readonly #handle: bigint;
  #closed = false;
  #closeAttempted = false;
  #finish: Promise<void> | undefined;
  private constructor(binding: Api, handle: bigint, name: string) { this.#api = binding; this.#handle = handle; this.name = name; }
  static create(): WindowsProcessJob {
    const binding = api(), name = `Local\\CodexDiscordProcess_${randomUUID()}`;
    const handle: unknown = binding.create(null, name);
    const createError = binding.error() as number;
    if (!valid(handle)) throw new WindowsProcessJobError('CreateJobObjectW', createError);
    const owner = new WindowsProcessJob(binding, handle, name); retained.add(owner);
    try {
      if (createError === 183) throw new WindowsProcessJobError('job-name-already-exists', createError);
      // Win64 x64/ARM64 ABI: BASIC_LIMIT_INFORMATION 64 + IO_COUNTERS 48 + 4 SIZE_T.
      const limits = Buffer.alloc(144); limits.writeUInt32LE(0x2000, 16); // KILL_ON_JOB_CLOSE
      requireBool(binding.limits(handle, 9, limits, limits.length), 'SetInformationJobObject', binding);
      return owner;
    } catch (primary) {
      try { owner.#close(); } catch (cleanup) { throw new AggregateError([primary, cleanup], 'Windows process job retained'); }
      throw primary;
    }
  }
  terminate(): void {
    if (this.#closed) return;
    requireBool(this.#api.terminate(this.#handle, 1), 'TerminateJobObject', this.#api);
  }
  finish(timeoutMs = 5000): Promise<void> {
    return this.#finish ??= this.#finishOwned(timeoutMs);
  }
  async #finishOwned(timeoutMs: number): Promise<void> {
    this.terminate();
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const counts = Buffer.alloc(48);
      requireBool(this.#api.query(this.#handle, 1, counts, counts.length, null), 'QueryInformationJobObject', this.#api);
      if (counts.readUInt32LE(40) === 0) break;
      if (performance.now() >= deadline) throw new WindowsProcessJobError('job-exit-timeout');
      await sleep(10);
    }
    this.#close();
  }
  #close(): void {
    if (this.#closed) return;
    if (this.#closeAttempted) throw new WindowsProcessJobError('unconfirmed-close');
    this.#closeAttempted = true;
    requireBool(this.#api.close(this.#handle), 'CloseHandle', this.#api);
    this.#closed = true; retained.delete(this);
  }
}

/** Called only by the fixed bootstrap before reading any launch request. */
export function joinCurrentProcessJob(name: string): void {
  if (!/^Local\\CodexDiscordProcess_[0-9a-f-]{36}$/.test(name)) throw new WindowsProcessJobError('job-name');
  const binding = api(), handle: unknown = binding.open(0x1, 0, name); // ASSIGN_PROCESS only
  if (!valid(handle)) throw new WindowsProcessJobError('OpenJobObjectW', binding.error() as number);
  try { requireBool(binding.assign(handle, binding.current()), 'AssignProcessToJobObject', binding); }
  finally { requireBool(binding.close(handle), 'CloseHandle(bootstrap)', binding); }
}
