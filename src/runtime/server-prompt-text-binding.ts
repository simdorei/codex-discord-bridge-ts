import {requireDiscordText} from '../discord/text.ts';
import {rustTrim} from '../app-server/value.ts';
import {clonePendingServerRequest, type PendingServerRequest} from '../app-server/server-request-state.ts';
import {ServerRequestOccurrence} from '../protocol/ids.ts';
import {requestFingerprint} from '../discord/components.ts';
import {ComponentWorkerError} from './component-worker/errors.ts';
export function promptTextFingerprint(input: PendingServerRequest, generation: bigint): string {
  const request = clonePendingServerRequest(input);
  return requestFingerprint(generation, ServerRequestOccurrence.prototype.asBytes.call(request.occurrence), request.id);
}
export function parsePromptTextBinding(answer: string): Readonly<{token: string; body: string}> | null {
  requireDiscordText(answer); const trimmed = answer.replace(/^\p{White_Space}+/u, ''), prefix = '[codex-reply:';
  if (!trimmed.startsWith(prefix)) return null;
  const rest = trimmed.slice(prefix.length), close = rest.indexOf(']');
  if (close < 0) throw new ComponentWorkerError('NoPendingRequest');
  const token = rest.slice(0, close), body = rest.slice(close + 1);
  if (token.length !== 32 || !/^[0-9A-Fa-f]{32}$/.test(token) || !/^\p{White_Space}/u.test(body) || rustTrim(body) === '') throw new ComponentWorkerError('NoPendingRequest');
  return Object.freeze({token, body: rustTrim(body)});
}
