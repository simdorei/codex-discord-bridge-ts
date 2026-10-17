import {statSync, readFileSync} from 'node:fs';
import {rustTrim, serdeField} from '../../app-server/value.ts';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {normalizeWorkspacePathPosix, stripWindowsExtendedPrefix} from '../../codex-state/thread-reference.ts';
import {requireDiscordText} from '../../discord/text.ts';
/** Native worker only. Path::is_file failure is false, but an actual subsequent
 * read/UTF-8 failure is not silently converted to an empty title mapping. */
export function mirrorRolloutAvailable(path: string): boolean {
  requireDiscordText(path); try { return statSync(path).isFile(); } catch { return false; }
}
export function loadMirrorSessionTitles(path: string): readonly (readonly [string, string])[] {
  requireDiscordText(path); if (!mirrorRolloutAvailable(path)) return [];
  const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(readFileSync(path));
  const mapping = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = rustTrim(raw); if (line === '') continue;
    let value: unknown; try { value = parseSerdeValue(line); } catch { continue; }
    const id = serdeField(value, 'id'), name = serdeField(value, 'thread_name');
    if (typeof id !== 'string' || typeof name !== 'string') continue;
    const title = rustTrim(name); if (title !== '') mapping.set(id, title);
  }
  return [...mapping].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
/** Source project grouping for the qualified POSIX profile; Windows lexical
 * normalization remains explicitly unqualified at the caller boundary. */
export function mirrorProjectIdentity(cwd: string): readonly [string, string] {
  requireDiscordText(cwd); const path = stripWindowsExtendedPrefix(cwd), parts = path.split(/[\\/]/u).filter(Boolean), count = parts.length;
  const asciiLower = (value: string) => value.replace(/[A-Z]/gu, character => character.toLowerCase());
  if (count >= 5 && asciiLower(parts[count - 4]!) === 'documents' && asciiLower(parts[count - 3]!) === 'codex' && Buffer.byteLength(parts[count - 2]!, 'utf8') === 10 && (parts[count - 1]!.startsWith('new-chat') || parts[count - 1]!.startsWith('chatgpt-conversation-'))) return ['codex:chats', '채팅'];
  if (path === '') return ['projectless:projectless', 'projectless'];
  return [normalizeWorkspacePathPosix(path), parts.at(-1) ?? 'projectless'];
}
