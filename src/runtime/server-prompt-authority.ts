import {PortableResidentLifecycle} from '../app-server/portable-resident-lifecycle.ts';
import {clonePendingServerRequest, pendingServerRequestEqual, type PendingServerRequest} from '../app-server/server-request-state.ts';
import {extractThreadId} from '../app-server/identity.ts';
import {serdeField, rustTrim} from '../app-server/value.ts';
import {StateAccessFacade as state} from '../store/state-access-facade.ts';
const completed = state.hasObservedCompletion, jobs = state.listQueueJobs, mapping = state.mirroredThreadId;
const token = Symbol('PromptAuthority');
export class PromptAuthorityError extends Error {
  constructor(reason: string) {super(`approval/input request authority is unavailable: ${reason}; no response was submitted`); this.name = 'PromptAuthorityError';}
}
interface Scope {readonly threadId: string; readonly turnId: string; readonly channelId: bigint; readonly userId: bigint; readonly generation: bigint}
export class PromptAuthority implements Scope {
  readonly threadId: string; readonly turnId: string; readonly channelId: bigint; readonly userId: bigint; readonly generation: bigint;
  readonly #scope: Scope;
  constructor(secret: symbol, scope: Scope) {
    if (secret !== token) throw new TypeError('Expected verified original prompt authority');
    this.#scope = Object.freeze({...scope}); this.threadId = scope.threadId; this.turnId = scope.turnId;
    this.channelId = scope.channelId; this.userId = scope.userId; this.generation = scope.generation; Object.freeze(this);
  }
  requireActor(channel: bigint, user: bigint): void {
    if (this.#scope.channelId !== channel || this.#scope.userId !== user) throw new PromptAuthorityError('original user or channel does not match');
  }
}
/** Source ordered authority verification. This is a snapshot, NOT an enduring
 * grant or permission to respond later without current-request revalidation.
 * No request is created, answered, restarted or remapped by this function. */
export async function verifyPromptAuthority(database: string, server: PortableResidentLifecycle,
  input: PendingServerRequest, generation: bigint): Promise<PromptAuthority> {
  if (typeof generation !== 'bigint' || generation < 0n || generation >= 1n << 64n) throw new TypeError('Expected u64 generation');
  const request = clonePendingServerRequest(input), questions = serdeField(request.params, 'questions');
  if (request.method === 'item/tool/requestUserInput' && Array.isArray(questions) && questions.some(q => serdeField(q, 'isSecret') === true)) throw new PromptAuthorityError('secret input requires the Codex app');
  const thread = extractThreadId(request.params); if (thread === null) throw new PromptAuthorityError('missing original thread');
  const turn = serdeField(request.params, 'turnId');
  if (typeof turn !== 'string' || turn === '' || rustTrim(turn) !== turn) throw new PromptAuthorityError('missing original turn');
  const snapshot = PortableResidentLifecycle.prototype.lifecycleSnapshot.call(server);
  if (snapshot.generation !== generation || !snapshot.healthy || snapshot.quarantined || snapshot.restartPending) throw new PromptAuthorityError('connection changed or is not ready');
  if (PortableResidentLifecycle.prototype.activeTurnId.call(server, thread) !== turn || await completed(database, thread, turn)) throw new PromptAuthorityError('original turn is no longer active');
  const matches = (await jobs(database)).filter(job => job.targetThreadId === thread && job.turnId === turn), job = matches[0];
  if (job === undefined) throw new PromptAuthorityError('original Discord request owner is unknown');
  if (matches.length !== 1 || job.state !== 'Running' || job.goalWaiting || job.appServerGeneration !== generation) throw new PromptAuthorityError('original execution ownership is uncertain');
  const channel = job.channelId, user = job.ownerUserId;
  if (channel <= 0n) throw new PromptAuthorityError('invalid original channel');
  if (user === null || user <= 0n) throw new PromptAuthorityError('original Discord user is unknown');
  const mapped = await mapping(database, channel);
  if (mapped !== null && mapped !== thread) throw new PromptAuthorityError('original channel mapping changed');
  if (PortableResidentLifecycle.prototype.generation.call(server) !== generation
    || !PortableResidentLifecycle.prototype.pendingServerRequests.call(server, thread).some(pending => pendingServerRequestEqual(pending, request))) throw new PromptAuthorityError('original request expired or changed');
  return new PromptAuthority(token, {threadId: thread, turnId: turn, channelId: channel, userId: user, generation});
}
Object.freeze(PromptAuthority.prototype);
