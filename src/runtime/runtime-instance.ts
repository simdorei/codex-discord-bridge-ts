import {createServer, type Server} from 'node:net';
import {mkdir, open, realpath, unlink} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {requireDiscordText} from '../discord/text.ts';
import {writePosixAtomicMarker} from './atomic-marker.ts';

export const RUNTIME_LOCK_NAME = '.codex_discord_rust.runtime.lock';
export const RUNTIME_SOCKET_NAME = '.codex_discord_rust.runtime.socket';

/** POSIX singleton. A stale socket fails closed: never unlink an occupied name
 * after a failed connect (that races another process acquiring the name).
 * Windows named-mutex ownership requires a separate adapter. The root must be
 * private to cooperating runtimes; hostile directory replacement is out of scope.
 * Release only after all runtime workers, heartbeat and drain cleanup have joined.
 */
export class PosixRuntimeInstance {
  #server: Server;
  #marker: string;
  #text: string;
  #release: Promise<void> | undefined;
  private constructor(server: Server, marker: string, text: string) {
    this.#server = server; this.#marker = marker; this.#text = text;
  }
  static async acquire(root: string): Promise<PosixRuntimeInstance> {
    requireDiscordText(root);
    if (process.platform === 'win32') throw new Error('Windows singleton adapter is not implemented');
    if (!isAbsolute(root)) throw new TypeError('Runtime root must be absolute');
    await mkdir(root, {recursive: true});
    const canonical = await realpath(root);
    const socket = join(canonical, RUNTIME_SOCKET_NAME);
    // Portable sockaddr_un bound, including trailing NUL (macOS is shorter).
    if (Buffer.byteLength(socket) > 103) throw new RangeError('Runtime socket path is too long');
    const server = createServer(connection => connection.destroy());
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off('listening', ready); reject(error); };
      const ready = () => { server.off('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', ready);
      server.listen(socket);
    });
    const marker = join(canonical, RUNTIME_LOCK_NAME);
    const text = `pid=${process.pid}\nstarted_at=${Math.floor(Date.now() / 1000)}\n`;
    try {
      await writePosixAtomicMarker(marker, text);
      return new PosixRuntimeInstance(server, marker, text);
    } catch (error) {
      try { await closeServer(server); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Singleton acquisition cleanup failed'); }
      throw error;
    }
  }
  release(): Promise<void> {
    return this.#release ??= this.#finish();
  }
  async #finish(): Promise<void> {
    let failure: unknown;
    let failed = false;
    try {
      // Keep socket ownership until marker cleanup completes.
      const handle = await open(this.#marker, 'r');
      let matches = false;
      try {
        const bytes = Buffer.alloc(129);
        let used = 0;
        while (used < bytes.length) {
          const result = await handle.read(bytes, used, bytes.length - used, null);
          if (result.bytesRead === 0) break;
          used += result.bytesRead;
        }
        matches = used <= 128 && bytes.subarray(0, used).equals(Buffer.from(this.#text));
      } finally { await handle.close(); }
      if (matches) await unlink(this.#marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { failed = true; failure = error; }
    }
    try { await closeServer(this.#server); }
    catch (error) {
      if (failed) throw new AggregateError([failure, error], 'Singleton release failed');
      throw error;
    }
    if (failed) throw failure;
  }
}
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
