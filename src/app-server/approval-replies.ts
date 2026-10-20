import {AppServerInvalidReplyError} from './client-errors.ts';
import {rustTrim, serdeField, serdeObject} from './value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
export interface ParsedApprovalAnswer {readonly decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'; readonly legacyDecision: 'approved' | 'approved_for_session' | 'denied' | 'abort'; readonly scope: 'turn' | 'session'}
const accept = new Set(['approve', 'approved', 'accept', 'yes', 'y', 'ok', '예', '네', '승인']);
const session = new Set(['approve session', 'accept session', 'session', 'approve_for_session']);
const decline = new Set(['decline', 'reject', 'no', 'n', '아니요', '거절']);
const cancel = new Set(['cancel', 'skip', 'dismiss', '건너뛰기', '취소']);
export function parseApprovalAnswer(answer: string): ParsedApprovalAnswer {
  requireDiscordText(answer); const normalized = rustTrim(answer), lower = normalized.toLowerCase();
  if (normalized === '1' || accept.has(lower)) return Object.freeze({decision: 'accept', legacyDecision: 'approved', scope: 'turn'});
  if (normalized === '2' || session.has(lower)) return Object.freeze({decision: 'acceptForSession', legacyDecision: 'approved_for_session', scope: 'session'});
  if (normalized === '3' || decline.has(lower)) return Object.freeze({decision: 'decline', legacyDecision: 'denied', scope: 'turn'});
  if (cancel.has(lower)) return Object.freeze({decision: 'cancel', legacyDecision: 'abort', scope: 'turn'});
  throw new AppServerInvalidReplyError('Unrecognized approval reply. Use 1 to approve, 2 to approve for this session, 3 to decline, or cancel to skip.');
}
/** Pure payload construction only: no approval is submitted and no permissions
 * are changed. Caller must verify exact original occurrence/actor before sending. */
export function buildApprovalResponse(method: string, params: unknown, input: string): Readonly<{payload: unknown; action: string}> {
  requireDiscordText(method); const answer = parseApprovalAnswer(input); let payload: unknown, action: string;
  if (method === 'mcpServer/elicitation/request') {
    action = answer.decision === 'acceptForSession' ? 'accept' : answer.decision;
    payload = {action, content: action === 'accept' ? {} : null, _meta: null};
  } else if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    action = answer.decision; payload = {decision: action};
  } else if (method === 'item/permissions/requestApproval') {
    action = answer.decision;
    if (answer.decision === 'accept' || answer.decision === 'acceptForSession') {
      const requested = serdeField(cloneOwnedSerdeValue(params), 'permissions');
      payload = {permissions: serdeObject(requested) ? requested : {network: null, fileSystem: null}, scope: answer.scope};
    } else payload = {permissions: {network: null, fileSystem: null}, scope: 'turn', strictAutoReview: false};
  } else if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    action = answer.legacyDecision; payload = {decision: action};
  } else throw new AppServerInvalidReplyError(`Unsupported app-server approval request method: ${method}`);
  return Object.freeze({payload: cloneOwnedSerdeValue(payload), action});
}
