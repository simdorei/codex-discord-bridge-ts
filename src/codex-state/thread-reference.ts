import {types} from 'node:util';
import {rustTrim} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
import type {ThreadInfo} from './thread.ts';

type Kind = 'NoThreads' | 'NoAlternate' | 'IndexOutOfRange' | 'Ambiguous' | 'NotFound';
export class ThreadResolveError extends Error {
  readonly kind: Kind;
  readonly reference: string;
  readonly archived: boolean;
  readonly options: string;
  constructor(kind: Kind, reference = '', archived = false, options = '') {
    super(kind === 'NoThreads' ? `No ${archived ? 'archived ' : ''}Codex threads found in the local state DB.`
      : kind === 'NoAlternate' ? 'No alternate thread found.'
      : kind === 'IndexOutOfRange' ? `${archived ? 'Archived ' : 'Thread '}thread index out of range: ${reference}`
      : kind === 'Ambiguous' ? `Multiple threads match reference \`${reference}\`. Use one exact ID: ${options}`
      : `Thread not found: ${reference}`);
    this.name = 'ThreadResolveError'; this.kind = kind; this.reference = reference;
    this.archived = archived; this.options = options;
  }
}
function lower(value: string): string {
  if (process.versions.unicode !== '17.0') throw new Error('Thread reference case mapping requires qualified Unicode 17.0');
  return value.toLowerCase();
}
const asciiLower = (value: string) => value.replace(/[A-Z]/g, char => char.toLowerCase());
const fullUuid = (value: string) => value.length === 36 && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
const shortId = (value: string) => value.length >= 4 && /^[0-9a-fA-F-]+$/.test(value);
const numeric = (value: string) => /^[0-9]*$/.test(value);

export function stripWindowsExtendedPrefix(path: string): string {
  requireDiscordText(path);
  const value = rustTrim(path);
  return value.startsWith('\\\\?\\UNC\\') ? '\\\\' + value.slice(8)
    : value.startsWith('\\\\?\\') ? value.slice(4) : value;
}
/** Exact source POSIX lexical components/pop profile. Parent components pop
 * an existing segment; excess parents are dropped, unlike path.normalize().
 * Windows Path::components is a separate pending qualification. */
export function normalizeWorkspacePathPosix(path: string): string {
  const value = stripWindowsExtendedPrefix(path);
  if (value === '') return '';
  const rooted = value.startsWith('/'), parts: string[] = [];
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return (rooted ? '/' : '') + parts.join('/');
}
interface Row {readonly value: ThreadInfo; readonly id: string; readonly cwd: string}
function rows(threads: readonly ThreadInfo[]): Row[] {
  if (!Array.isArray(threads) || types.isProxy(threads)) throw new TypeError('Expected thread rows');
  const result: Row[] = [];
  for (let index = 0; index < threads.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(threads, String(index));
    if (entry === undefined || !Object.hasOwn(entry, 'value')) throw new TypeError('Expected dense thread rows');
    const value: unknown = entry.value;
    if (value === null || typeof value !== 'object' || types.isProxy(value)) throw new TypeError('Expected thread data');
    const field = (name: string): string => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Expected own thread field');
      requireDiscordText(descriptor.value); return descriptor.value;
    };
    result.push({value: value as ThreadInfo, id: field('id'), cwd: field('cwd')});
  }
  return result;
}
function workspaceName(row: Row): string {
  const cwd = stripWindowsExtendedPrefix(row.cwd);
  return cwd.split(/[\\/]/).filter(part => part !== '').at(-1) ?? (cwd === '' ? '-' : cwd);
}
function references(threads: readonly Row[]): Map<string, string> {
  const totals = new Map<string, number>(), seen = new Map<string, number>(), initial = new Map<string, string>();
  for (const row of threads) {const key = lower(workspaceName(row)); totals.set(key, (totals.get(key) ?? 0) + 1);}
  for (const row of threads) {
    const name = workspaceName(row), key = lower(name), count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    const reserved = key === 'other' || key === 'next' || numeric(key) || fullUuid(key) || shortId(key);
    initial.set(row.id, reserved || totals.get(key)! > 1 ? `${name}:${count}` : name);
  }
  const result = new Map<string, string>();
  for (const [id, alias] of [...initial].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    // Rust char::is_alphanumeric = Alphabetic or General_Category Number.
    const collision = !/^[\p{Alphabetic}\p{Number}_.:-]*$/u.test(alias)
      || threads.some(other => other.id !== id
        && (lower(other.id) === lower(alias) || lower(workspaceName(other)) === lower(alias)));
    result.set(id, collision ? id : alias);
  }
  return result;
}
/** Returns a detached alias map, not a target authorization token. */
export function workspaceReferenceMap(threads: readonly ThreadInfo[]): ReadonlyMap<string, string> {
  return references(rows(threads));
}
/** Source non-Windows resolver, borrowing the exact input row. Exact identity,
 * UUID, other/next and index priority precede the combined alias/path/prefix
 * namespace. Ambiguity never selects the first match. Windows path qualification
 * and binding to an actual selected/mapped snapshot remain separate. */
export function resolveThreadRefPosix(
  threads: readonly ThreadInfo[], threadRef: string, selected: string | null, archived: boolean,
): ThreadInfo {
  if (typeof archived !== 'boolean') throw new TypeError('Expected archived flag');
  const entries = rows(threads);
  if (entries.length === 0) throw new ThreadResolveError('NoThreads', '', archived);
  requireDiscordText(threadRef); if (selected !== null) requireDiscordText(selected);
  const reference = rustTrim(threadRef), normalized = lower(reference);
  const exact = entries.find(row => row.id === reference);
  if (exact !== undefined) return exact.value;
  if (fullUuid(reference)) {
    const match = entries.find(row => asciiLower(row.id) === asciiLower(reference));
    if (match === undefined) throw new ThreadResolveError('NotFound', reference);
    return match.value;
  }
  if (normalized === 'other' || normalized === 'next') {
    const match = entries.find(row => row.id !== selected);
    if (match === undefined) throw new ThreadResolveError('NoAlternate');
    return match.value;
  }
  if (numeric(reference)) {
    const digits = reference.replace(/^0+/, '') || '0';
    const index = digits.length > 20 || (digits.length === 20 && digits > '18446744073709551615') ? 0n : BigInt(digits);
    if (index < 1n || index > BigInt(entries.length)) throw new ThreadResolveError('IndexOutOfRange', reference, archived);
    return entries[Number(index - 1n)]!.value;
  }
  const refs = references(entries), path = normalizeWorkspacePathPosix(reference);
  const matches = entries.filter(row => (shortId(reference) && lower(row.id).startsWith(normalized))
    || lower(refs.get(row.id)!) === normalized
    || normalizeWorkspacePathPosix(row.cwd) === path
    || lower(workspaceName(row)) === normalized);
  if (matches.length === 0) throw new ThreadResolveError('NotFound', reference);
  if (matches.length > 1) throw new ThreadResolveError('Ambiguous', reference, false, matches.slice(0, 10).map(row => row.id).join(', '));
  return matches[0]!.value;
}
