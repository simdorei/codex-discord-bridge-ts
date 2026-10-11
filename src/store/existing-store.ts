import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {joinRuntimePath} from '../runtime/runtime-paths/path-text.ts';
import {requireDiscordText} from '../discord/text.ts';

/**
 * Open an existing SQLite database in read-write mode without creating or repairing.
 *
 * Caller owns the returned DatabaseSync handle and is responsible for closing it.
 */
export function openExisting(path: string, timeoutMs = 5000): DatabaseSync {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>5000)throw new RangeError('Expected SQLite timeout from 0 through 5000ms');
  requireDiscordText(path);if(path.includes('\0'))throw new TypeError('Invalid SQLite path');
  // Node pathToFileURL normalizes '..' lexically. SQLite URI parsing must leave
  // native POSIX traversal intact. Encode each component so ?/#/% remain names.
  // Windows retains the previous URI adapter; native Windows traversal is unqualified.
  const native=joinRuntimePath(process.cwd(),path,'posix');
  const url=process.platform==='win32'?pathToFileURL(resolve(path)).href+'?mode=rw':'file://'+native.split('/').map(encodeURIComponent).join('/')+'?mode=rw';

  return new DatabaseSync(url, {
    timeout: timeoutMs,
    enableForeignKeyConstraints: false,
  });
}
