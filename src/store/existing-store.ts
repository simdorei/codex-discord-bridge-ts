import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Open an existing SQLite database in read-write mode without creating or repairing.
 *
 * Caller owns the returned DatabaseSync handle and is responsible for closing it.
 */
export function openExisting(path: string): DatabaseSync {
  const url = pathToFileURL(resolve(path));
  url.searchParams.set('mode', 'rw');

  return new DatabaseSync(url.href, {
    timeout: 5000,
    enableForeignKeyConstraints: false,
  });
}
