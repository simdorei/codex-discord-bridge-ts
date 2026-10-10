import {types} from 'node:util';
import {type ComponentId, threadFingerprint, requestFingerprint} from '../../discord/components.ts';
import {snapshotComponentId} from '../discord-dispatch/delivery-identity.ts';
import {clonePendingServerRequest, type PendingServerRequest} from '../../app-server/server-request-state.ts';
import {ServerRequestOccurrence, type RequestId} from '../../protocol/ids.ts';
import {extractThreadId} from '../../app-server/identity.ts';
import {serdeField} from '../../app-server/value.ts';
import {buildApprovalResponse} from '../../app-server/approval-replies.ts';
import {buildInputResponse} from '../../app-server/input-replies.ts';
import {ComponentWorkerError} from './errors.ts';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {ResidentStateError} from '../../app-server/resident-state.ts';
export interface ComponentResponse {readonly requestId: RequestId; readonly occurrence: ServerRequestOccurrence; readonly payload: unknown; readonly confirmation: string; readonly generation: bigint}
const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval']);
export function isApprovalMethod(method: string, params: unknown): boolean {
  return approvalMethods.has(method) || method === 'mcpServer/elicitation/request' && serdeField(params, 'mode') === 'url';
}
export function capturePendingRequests(input: readonly PendingServerRequest[]): readonly PendingServerRequest[] {
  if (!Array.isArray(input) || types.isProxy(input)) throw new TypeError('Expected pending request array');
  const result: PendingServerRequest[] = [];
  for (let i = 0; i < input.length; i++) {const d = Object.getOwnPropertyDescriptor(input, String(i)); if (!d || !Object.hasOwn(d, 'value')) throw new TypeError('Expected own pending request'); result.push(clonePendingServerRequest(d.value));}
  return Object.freeze(result);
}
function exactlyOne(requests: readonly PendingServerRequest[]): PendingServerRequest {
  if (requests.length === 0) throw new ComponentWorkerError('NoPendingRequest');
  if (requests.length > 1) throw new ComponentWorkerError('AmbiguousPendingRequest'); return requests[0]!;
}
const answers = new Map([['Approve', '1'], ['ApproveSession', '2'], ['Reject', '3'], ['Cancel', 'cancel']]);
/** Select and build only. Confirmation text is a prospective payload, not proof
 * of submission. Legacy expiry, actor authority and actual delivery remain later gates. */
export function buildComponentResponse(input: ComponentId, pending: readonly PendingServerRequest[], generation: bigint): ComponentResponse {
  if (typeof generation !== 'bigint' || generation < 0n || generation >= 1n << 64n) throw new TypeError('Expected u64 generation');
  const component = snapshotComponentId(input);
  if ('AsyncChoice' in component || 'RecoveryPublicationDecision' in component || 'RecoveryAbandonDecision' in component) throw new ComponentWorkerError('InvalidComponent');
  if ('Busy' in component) throw new ComponentWorkerError('BusyChoice');
  const requests = capturePendingRequests(pending); let request: PendingServerRequest, inputValue: string | null = null, approvalValue: string | null = null;
  if ('Approval' in component) {
    request = exactlyOne(requests.filter(r => extractThreadId(r.params) === component.Approval.thread_id && isApprovalMethod(r.method, r.params)));
    approvalValue = answers.get(component.Approval.answer)!;
  } else if ('Input' in component) {
    request = exactlyOne(requests.filter(r => extractThreadId(r.params) === component.Input.thread_id && r.method === 'item/tool/requestUserInput')); inputValue = component.Input.value;
  } else {
    const bound = 'BoundApproval' in component ? component.BoundApproval : component.BoundInput;
    request = exactlyOne(requests.filter(r => {
      const thread = extractThreadId(r.params); if (thread === null) return false;
      return threadFingerprint(thread) === bound.thread_fingerprint && requestFingerprint(generation, ServerRequestOccurrence.prototype.asBytes.call(r.occurrence), r.id) === bound.request_fingerprint;
    }));
    if ('BoundApproval' in component) {if (!isApprovalMethod(request.method, request.params)) throw new ComponentWorkerError('NoPendingRequest'); approvalValue = answers.get(component.BoundApproval.answer)!;}
    else {if (request.method !== 'item/tool/requestUserInput') throw new ComponentWorkerError('NoPendingRequest'); inputValue = component.BoundInput.value;}
  }
  let payload: unknown, confirmation: string;
  try {
    if (approvalValue !== null) {const response = buildApprovalResponse(request.method, request.params, approvalValue); payload = response.payload; confirmation = `Approval response submitted: ${response.action}`;}
    else {payload = buildInputResponse(request.params, inputValue!).payload; confirmation = 'Codex input choice submitted.';}
  } catch (error) {throw new ComponentWorkerError('AppServer', error);}
  return Object.freeze({requestId: request.id, occurrence: request.occurrence, payload, confirmation, generation});
}
export function prepareComponentResponse(input: ComponentId, server: PortableResidentLifecycle): ComponentResponse {
  const component = snapshotComponentId(input);
  if ('RecoveryPublicationDecision' in component || 'RecoveryAbandonDecision' in component) throw new ComponentWorkerError('InvalidComponent');
  if ('Busy' in component) throw new ComponentWorkerError('BusyChoice');
  let requests: readonly PendingServerRequest[], generation: bigint;
  try {
    generation = PortableResidentLifecycle.prototype.generation.call(server);
    requests = PortableResidentLifecycle.prototype.pendingServerRequests.call(server, null);
    const actual = PortableResidentLifecycle.prototype.generation.call(server);
    if (actual !== generation) throw new ResidentStateError({kind: 'GenerationMismatch', expected: generation, actual});
  } catch (error) {throw new ComponentWorkerError('AppServer', error);}
  return buildComponentResponse(component, requests, generation);
}
