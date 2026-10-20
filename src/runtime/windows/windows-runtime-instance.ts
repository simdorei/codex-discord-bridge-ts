import {open, unlink} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {StoreAuthorityDomain, authorityStorePath, requireStoreAuthorityPath} from '../../store/store-authority-domain.ts';
import {RUNTIME_LOCK_NAME} from '../runtime-instance.ts';
import {RUNTIME_HEARTBEAT_NAME, type RuntimeHeartbeatPort} from '../runtime-heartbeat.ts';
import {
  acquireWindowsAtomicMarkerProfile, assertWindowsAtomicMarkerHeld, publishWindowsAtomicMarker,
  shutdownWindowsAtomicMarkerProfile, type WindowsAtomicMarker, type WindowsAtomicMarkerProfile,
} from './windows-atomic-marker.ts';

const construction = Object.freeze({});

/** Owns the Rust-compatible named mutex through every marker write and joined
 * store owner. A failed native close/publication never permits a second owner. */
export class WindowsRuntimeInstance {
  readonly #root: string;
  readonly #profile: WindowsAtomicMarkerProfile;
  readonly #lockText: string;
  #tail: Promise<void> = Promise.resolve();
  #release: Promise<void> | undefined;
  #authority: StoreAuthorityDomain | undefined;

  private constructor(token: object, root: string, profile: WindowsAtomicMarkerProfile, lockText: string) {
    if (token !== construction) throw new TypeError('Expected acquired Windows runtime singleton');
    this.#root = root; this.#profile = profile; this.#lockText = lockText;
  }

  static async acquire(root: string): Promise<WindowsRuntimeInstance> {
    if (!isAbsolute(root)) throw new TypeError('Runtime root must be absolute');
    const pinned = authorityStorePath(root);
    const profile = acquireWindowsAtomicMarkerProfile(pinned);
    const text = `pid=${process.pid}\nstarted_at=${Math.floor(Date.now() / 1000)}\n`;
    try {
      await publishWindowsAtomicMarker(profile, 'lock', text);
      return new WindowsRuntimeInstance(construction, pinned, profile, text);
    } catch (primary) {
      const cleanup = await shutdownWindowsAtomicMarkerProfile(profile);
      if (cleanup.closure !== 'closed') throw new AggregateError([primary, cleanup], 'Windows singleton acquisition ownership retained');
      throw primary;
    }
  }

  requireHeldRoot(root: string): void {
    if (authorityStorePath(root) !== this.#root || this.#release !== undefined)
      throw new TypeError('Expected the currently held original runtime singleton');
    assertWindowsAtomicMarkerHeld(this.#profile, this.#root);
  }

  retainStoreAuthority(root: string, domain: StoreAuthorityDomain): void {
    this.requireHeldRoot(root);
    if (this.#authority !== undefined) throw new TypeError('Runtime singleton already has store accounting');
    requireStoreAuthorityPath(domain, join(this.#root, 'discord_mirror.sqlite'));
    this.#authority = domain;
  }

  publishMarker(marker: WindowsAtomicMarker, text: string): Promise<void> {
    this.requireHeldRoot(this.#root);
    // Heartbeat and drain acknowledgement share one native writer; they cannot
    // reject each other as busy or release the mutex while a callback is pending.
    const task = this.#tail.then(async () => {
      assertWindowsAtomicMarkerHeld(this.#profile, this.#root);
      await publishWindowsAtomicMarker(this.#profile, marker, text);
    });
    this.#tail = task.then(() => undefined, () => undefined);
    return task;
  }

  heartbeatPort(): RuntimeHeartbeatPort {
    this.requireHeldRoot(this.#root);
    return Object.freeze({
      publish: (text: string) => WindowsRuntimeInstance.prototype.publishMarker.call(this, 'heartbeat', text),
      removeIfOwned: async (text: string) => {
        this.requireHeldRoot(this.#root);
        await this.#tail;
        await removeOwnedMarker(join(this.#root, RUNTIME_HEARTBEAT_NAME), text);
      },
    });
  }

  release(): Promise<void> {
    if (this.#authority !== undefined && !StoreAuthorityDomain.prototype.snapshot.call(this.#authority).closed)
      throw new Error('Store authority ownership must close before singleton release');
    return this.#release ??= this.#finish();
  }

  async #finish(): Promise<void> {
    await this.#tail;
    // If a prior operation retained file debt, keep exclusion and evidence.
    assertWindowsAtomicMarkerHeld(this.#profile, this.#root);
    await removeOwnedMarker(join(this.#root, RUNTIME_LOCK_NAME), this.#lockText);
    const closed = await shutdownWindowsAtomicMarkerProfile(this.#profile);
    if (closed.closure !== 'closed') throw new Error('Windows singleton ownership retained: native close unconfirmed');
  }
}

async function removeOwnedMarker(path: string, expected: string): Promise<void> {
  let handle;
  try { handle = await open(path, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let matches = false;
  try {
    const bytes = Buffer.alloc(129); let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, null);
      if (read.bytesRead === 0) break;
      used += read.bytesRead;
    }
    matches = used <= 128 && bytes.subarray(0, used).equals(Buffer.from(expected));
  } finally { await handle.close(); }
  if (matches) try { await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
