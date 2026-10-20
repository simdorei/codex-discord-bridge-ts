import type {ThreadInfo} from '../../codex-state/thread.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
/** Validate an already passively captured native source record. */
export function validateMirrorThreadInfo(row: unknown): asserts row is ThreadInfo {
  const keys = ['id', 'title', 'cwd', 'rolloutPath', 'model', 'reasoningEffort', 'updatedAt', 'tokensUsed', 'archivedAt'];
  if (row === null || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw new TypeError('Expected exact source thread');
  for (const key of keys.slice(0, 6)) requireDiscordText(own(row, key));
  for (const key of ['updatedAt', 'archivedAt', 'tokensUsed']) {
    const value = own(row, key);
    if (key === 'tokensUsed' && value === null) continue;
    if (typeof value !== 'bigint' || value < -(1n << 63n) || value >= 1n << 63n) throw new TypeError('Expected i64 source field');
  }
}
