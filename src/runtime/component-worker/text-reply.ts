import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {ResidentStateError} from '../../app-server/resident-state.ts';
import type {PendingServerRequest} from '../../app-server/server-request-state.ts';
import {buildApprovalResponse} from '../../app-server/approval-replies.ts';
import {buildInputResponse} from '../../app-server/input-replies.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {parsePromptTextBinding, promptTextFingerprint} from '../server-prompt-text-binding.ts';
import {verifyPromptAuthority} from '../server-prompt-authority.ts';
import {ComponentWorkerError} from './errors.ts';
import {capturePendingRequests, isApprovalMethod} from './response.ts';
const eligible = (r: PendingServerRequest): boolean => r.method === 'item/tool/requestUserInput' || isApprovalMethod(r.method, r.params);
/** The vector must already be scoped to the requested thread. This pure selector
 * grants no actor authority and performs no submission. */
export function selectPendingTextReply(input: readonly PendingServerRequest[], answer: string, generation: bigint): Readonly<{request: PendingServerRequest; answer: string}> | null {
  if (typeof generation !== 'bigint' || generation < 0n || generation >= 1n << 64n) throw new TypeError('Expected u64 generation');
  const requests = capturePendingRequests(input), binding = parsePromptTextBinding(answer);
  const matches = requests.filter(r => eligible(r) && (binding === null || promptTextFingerprint(r, generation) === binding.token));
  if (matches.length === 0) {if (binding !== null) throw new ComponentWorkerError('NoPendingRequest'); return null;}
  if (matches.length > 1) throw new ComponentWorkerError('AmbiguousPendingRequest');
  return Object.freeze({request: matches[0]!, answer: binding === null ? answer : binding.body});
}
function snapshot(thread: string, server: PortableResidentLifecycle): Readonly<{generation: bigint; requests: readonly PendingServerRequest[]}> {
  requireDiscordText(thread);
  try {
    const generation = PortableResidentLifecycle.prototype.generation.call(server), requests = PortableResidentLifecycle.prototype.pendingServerRequests.call(server, thread);
    const actual = PortableResidentLifecycle.prototype.generation.call(server);
    if (actual !== generation) throw new ResidentStateError({kind: 'GenerationMismatch', expected: generation, actual});
    return {generation, requests};
  } catch (error) {throw new ComponentWorkerError('AppServer', error);}
}
export function pendingTextReplyAvailable(thread: string, server: PortableResidentLifecycle): boolean {return snapshot(thread, server).requests.some(eligible);}
/** Original actor/turn verification precedes answer parsing. Resident.respond owns
 * final occurrence/generation/turn checks and write uncertainty; never auto-retry. */
export async function handlePendingTextReply(thread: string, answer: string, server: PortableResidentLifecycle, database: string, channel: bigint, user: bigint, signal?: AbortSignal): Promise<string | null> {
  requireDiscordText(answer); requireDiscordText(database);
  for (const id of [channel, user]) if (typeof id !== 'bigint' || id < 0n || id >= 1n << 64n) throw new TypeError('Expected u64 original actor');
  signal?.throwIfAborted(); const {generation, requests} = snapshot(thread, server), selected = selectPendingTextReply(requests, answer, generation);
  if (selected === null) return null;
  try {const authority = await verifyPromptAuthority(database, server, selected.request, generation); authority.requireActor(channel, user);}
  catch (error) {throw new ComponentWorkerError('Authority', error);}
  signal?.throwIfAborted(); let payload: unknown, confirmation: string;
  try {
    if (selected.request.method === 'item/tool/requestUserInput') {payload = buildInputResponse(selected.request.params, selected.answer).payload; confirmation = 'Codex input reply submitted.';}
    else {const response = buildApprovalResponse(selected.request.method, selected.request.params, selected.answer); payload = response.payload; confirmation = `Approval response submitted: ${response.action}`;}
    await PortableResidentLifecycle.prototype.respond.call(server, selected.request.id, selected.request.occurrence, payload, generation, signal);
  } catch (error) {throw new ComponentWorkerError('AppServer', error);}
  return confirmation;
}
