import type {DatabaseSync} from 'node:sqlite';
import {usingInitializedStore} from './owned-scope.ts';
import {decodeI64, decodeOptionalI64, decodeTextField, textDecoderFor} from './sqlite-values.ts';
import {requireDiscordText} from '../discord/text.ts';
export interface RemainingDiscordIds {
  readonly threadIds: readonly bigint[];
  readonly projectChannelIds: readonly bigint[];
}
export interface MirrorTarget {
  readonly codexThreadId: string;
  readonly threadTitle: string;
  readonly discordChannelId: bigint;
  readonly discordThreadId: bigint;
}
function collect(db: DatabaseSync, sql: string): bigint[] {
  const query = db.prepare(sql); query.setReadBigInts(true);
  const result: bigint[] = [];
  for (const row of query.iterate()) {
    const value = decodeOptionalI64(row.id, 'Discord mapping ID');
    if (value !== null && value !== 0n) result.push(value);
  }
  return result;
}
/** Source read adapter uses the bridge store initializer, which can migrate/create
 * its owned store. This is not the separate read-only original Codex state DB. */
export async function remainingDiscordIds(path: string): Promise<RemainingDiscordIds> {
  requireDiscordText(path);
  return usingInitializedStore(path, db => {
    const ids = collect(db, 'SELECT discord_thread_id AS id FROM mirror_threads');
    const projects = collect(db, 'SELECT discord_channel_id AS id FROM mirror_projects');
    return Object.freeze({
      threadIds: Object.freeze([...new Set(ids)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)),
      projectChannelIds: Object.freeze(projects),
    });
  });
}
export async function mirrorTargets(path: string, limit: bigint): Promise<readonly MirrorTarget[]> {
  requireDiscordText(path);
  if (typeof limit !== 'bigint' || limit < -(1n << 63n) || limit >= 1n << 63n) throw new TypeError('Expected i64 mirror target limit');
  return usingInitializedStore(path, db => mirrorTargetsIn(db,limit));
}
/** Borrowed connection form of the same source query and decoder. */
export function mirrorTargetsIn(db:DatabaseSync,limit:bigint):readonly MirrorTarget[]{
  if(typeof limit!=='bigint'||limit<-(1n<<63n)||limit>=1n<<63n)throw new TypeError('Expected i64 mirror target limit');

    const query = db.prepare(`SELECT codex_thread_id,thread_title,discord_channel_id,discord_thread_id,
      CAST(codex_thread_id AS BLOB) AS raw_id,CAST(thread_title AS BLOB) AS raw_title,
      (SELECT encoding FROM pragma_encoding) AS encoding
      FROM mirror_threads ORDER BY updated_at DESC LIMIT ?`);
    query.setReadBigInts(true);
    const result: MirrorTarget[] = [];
    for (const row of query.iterate(limit)) {
      const decoder = textDecoderFor(row.encoding);
      const codexThreadId = decodeTextField(row.codex_thread_id, row.raw_id, 'codex_thread_id', false, decoder)!;
      const threadTitle = decodeTextField(row.thread_title, row.raw_title, 'thread_title', false, decoder)!;
      const discordChannelId = decodeI64(row.discord_channel_id, 'discord_channel_id');
      const discordThreadId = decodeI64(row.discord_thread_id, 'discord_thread_id');
      // Decode every selected row before this source filter; SQL limit precedes it.
      if (codexThreadId !== '' && discordThreadId !== 0n) result.push(Object.freeze({codexThreadId, threadTitle, discordChannelId, discordThreadId}));
    }
    return Object.freeze(result);
}
