import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Open an existing SQLite database in read-write mode without creating or repairing.
 *
 * Caller owns the returned DatabaseSync handle and is responsible for closing it.
 */
export function openExisting(path: string, timeoutMs = 5000): DatabaseSync {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>5000)throw new RangeError('Expected SQLite timeout from 0 through 5000ms');
  const url = pathToFileURL(resolve(path));
  url.searchParams.set('mode', 'rw');

  return new DatabaseSync(url.href, {
    timeout: timeoutMs,
    enableForeignKeyConstraints: false,
  });
}
