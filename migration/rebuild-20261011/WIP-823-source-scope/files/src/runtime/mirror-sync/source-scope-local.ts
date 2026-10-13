import {CodexThreadStore} from '../../codex-state/store.ts';
import type {ThreadInfo} from '../../codex-state/thread.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {statSync} from 'node:fs';

/** Worker-only native scope collection. Two source queries are intentionally not
 * collapsed into one: a newly introduced candidate absent from the first read
 * fails the complete operation rather than being silently omitted. */
export async function loadMirrorSourceScope(codex: string, mirror: string, limit: bigint | null): Promise<readonly ThreadInfo[]> {
  requireDiscordText(codex); requireDiscordText(mirror);
  if (limit !== null && (typeof limit !== 'bigint' || limit < -(1n << 63n) || limit >= 1n << 63n)) throw new TypeError('Expected optional i64 limit');
  const store = CodexThreadStore.open(codex);
  const all = new Map(store.loadRecentThreads(0n).map(thread => [thread.id, thread]));
  const candidates = [...(limit === null ? store.loadMirrorRootThreads(0n) : store.loadRecentThreads(limit < 1n ? 1n : limit > 100n ? 100n : limit))];
  if (limit === null) {
    const original = statSync(codex, {bigint: true});
    let bridge;
    try { bridge = statSync(mirror, {bigint: true}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (bridge !== undefined && original.dev === bridge.dev && original.ino === bridge.ino) throw new TypeError('Codex state and bridge store must be different files');
    for (const mapping of await state.mirrorTargets(mirror, (1n << 63n) - 1n)) {
      const thread = all.get(mapping.codexThreadId);
      if (thread !== undefined) candidates.push(thread);
    }
  }
  const seen = new Set<string>();
  const result: ThreadInfo[] = [];
  for (const candidate of candidates) {
    const thread = all.get(candidate.id);
    if (thread === undefined) throw new Error(`mapped fork ${candidate.id} is unavailable`);
    if (!seen.has(candidate.id)) { seen.add(candidate.id); result.push(thread); }
  }
  // Stable sorting retains original candidate order for equal update times.
  result.sort((a, b) => a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0);
  return Object.freeze(result);
}
