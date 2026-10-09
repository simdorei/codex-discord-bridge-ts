import {statSync} from 'node:fs';
import {DatabaseSync, type SQLInputValue} from 'node:sqlite';
import {decodeOptionalI64, decodeTextField, textDecoderFor} from '../store/sqlite-values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {CodexStateError} from './errors.ts';
import type {ThreadInfo} from './thread.ts';

const owned = Symbol('CodexThreadStore');
const textColumns = ['id', 'title', 'cwd', 'rollout_path', 'model', 'reasoning_effort'] as const;
const fields = 'id,title,cwd,updated_at,rollout_path,model,reasoning_effort,tokens_used';
const rawFields = textColumns.map(column => `CAST(${column} AS BLOB) AS raw_${column}`).join(',');
function decode(row: Record<string, unknown>, archived: boolean): ThreadInfo {
  const decoder = textDecoderFor(row.encoding);
  const text = (name: typeof textColumns[number], optional = true) =>
    decodeTextField(row[name], row['raw_' + name], name, optional, decoder);
  // Preserve original row conversion order and optional/default distinctions.
  const id = text('id', false)!, title = text('title') ?? '', cwd = text('cwd') ?? '';
  const updatedAt = decodeOptionalI64(row.updated_at, 'updated_at') ?? 0n;
  const rolloutPath = text('rollout_path') ?? '', model = text('model') ?? '', reasoningEffort = text('reasoning_effort') ?? '';
  const tokensUsed = decodeOptionalI64(row.tokens_used, 'tokens_used');
  const archivedAt = archived ? decodeOptionalI64(row.archived_at, 'archived_at') ?? 0n : 0n;
  return Object.freeze({id, title, cwd, updatedAt, rolloutPath, model, reasoningEffort, tokensUsed, archivedAt});
}
function limitValue(limit: bigint): void {
  if (typeof limit !== 'bigint' || limit < 0n || limit > 0xffff_ffffn) throw new TypeError('Expected u32 thread limit');
}
function connection<T>(path: string, run: (db: DatabaseSync) => T): T {
  let db: DatabaseSync | undefined;
  try {
    // rusqlite 0.40.2 initializes sqlite3_busy_timeout to 5000 on each open.
    db = new DatabaseSync(path, {readOnly: true, timeout: 5000});
    return run(db);
  } catch (error) {throw new CodexStateError('Sqlite', path, error);}
  finally {db?.close();}
}

/** Separate existing Codex state database; never initialize/migrate/create it.
 * Like the source, open probes once and each query uses a fresh read-only handle.
 * Synchronous native I/O still needs an owned offload boundary in production.
 * Node does not expose SQLITE_OPEN_NO_MUTEX; no Rust mutex/timing claim. */
export class CodexThreadStore {
  readonly #path: string;
  constructor(token: symbol, path: string) {
    if (token !== owned) throw new TypeError('Use CodexThreadStore.open');
    this.#path = path; Object.freeze(this);
  }
  static open(path: string): CodexThreadStore {
    requireDiscordText(path);
    let exists = false;
    try {exists = statSync(path).isFile();} catch {}
    if (!exists) throw new CodexStateError('StateDatabaseMissing', path);
    connection(path, () => {});
    return new CodexThreadStore(owned, path);
  }
  path(): string {return this.#path;}
  loadThread(id: string, archived: boolean): ThreadInfo | null {
    requireDiscordText(id);
    if (typeof archived !== 'boolean') throw new TypeError('Expected archived flag');
    return connection(this.#path, db => {
      const query = db.prepare(`SELECT ${fields},archived_at,${rawFields},(SELECT encoding FROM pragma_encoding) AS encoding FROM threads WHERE id=? AND archived=?`);
      query.setReadBigInts(true);
      const row = query.get(id, archived ? 1n : 0n);
      return row === undefined ? null : decode(row, archived);
    });
  }
  loadRecentThreads(limit = 0n): readonly ThreadInfo[] {
    return this.#query('WHERE archived = 0 ORDER BY updated_at DESC, id', limit, false);
  }
  loadUserRootThreads(limit = 0n): readonly ThreadInfo[] {
    return this.#query("WHERE archived = 0 AND source = 'vscode' AND COALESCE(thread_source, '') IN ('', 'user') AND title != '' ORDER BY updated_at DESC", limit, false);
  }
  loadMirrorRootThreads(limit = 0n): readonly ThreadInfo[] {
    return this.#query("WHERE archived = 0 AND source IN ('vscode','cli','app-server','appServer') AND COALESCE(thread_source, '') IN ('', 'user') AND title != '' ORDER BY updated_at DESC, id", limit, false);
  }
  loadArchivedThreads(limit = 0n): readonly ThreadInfo[] {
    return this.#query('WHERE archived = 1 ORDER BY archived_at DESC, updated_at DESC, id', limit, true);
  }
  #query(clause: string, limit: bigint, archived: boolean): readonly ThreadInfo[] {
    limitValue(limit);
    return connection(this.#path, db => {
      const query = db.prepare(`SELECT ${fields}${archived ? ',archived_at' : ''},${rawFields},(SELECT encoding FROM pragma_encoding) AS encoding FROM threads ${clause}${limit > 0n ? ' LIMIT ?' : ''}`);
      query.setReadBigInts(true);
      const params: SQLInputValue[] = limit > 0n ? [limit] : [];
      const result: ThreadInfo[] = [];
      for (const row of query.iterate(...params)) result.push(decode(row, archived));
      return Object.freeze(result);
    });
  }
}
Object.freeze(CodexThreadStore.prototype);
