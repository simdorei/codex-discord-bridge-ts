import {PortableResidentLifecycle} from '../app-server/portable-resident-lifecycle.ts';
import {clonePendingServerRequest, pendingServerRequestEqual, type PendingServerRequest} from '../app-server/server-request-state.ts';
import {extractThreadId} from '../app-server/identity.ts';
import {serializeDiscordComponent} from '../discord/components.ts';
import {requireDiscordText} from '../discord/text.ts';
import {verifyPromptAuthority, PromptAuthorityError} from './server-prompt-authority.ts';
import {buildServerPrompt, ServerPromptError, type ServerPrompt} from './server-prompt.ts';
export class PromptRedisplayChangedError extends Error {
  constructor() {super('pending approval/input changed while preparing its display; no new request was created'); this.name = 'PromptRedisplayChangedError';}
}
export interface PreparedPrompt {readonly request: PendingServerRequest; readonly generation: bigint; readonly prompt: ServerPrompt; readonly unavailable: boolean}
const owned = new WeakSet<object>();
export function isPreparedPrompt(value: unknown): value is PreparedPrompt {return value !== null && typeof value === 'object' && owned.has(value);}
export function preparedPromptEqual(a: PreparedPrompt, b: PreparedPrompt): boolean {
  if (!isPreparedPrompt(a) || !isPreparedPrompt(b)) throw new TypeError('Expected prepared prompt snapshots');
  return a.generation === b.generation && a.unavailable === b.unavailable && pendingServerRequestEqual(a.request, b.request)
    && a.prompt.threadId === b.prompt.threadId && a.prompt.text === b.prompt.text && a.prompt.components.length === b.prompt.components.length
    && a.prompt.components.every((value, i) => serializeDiscordComponent(value) === serializeDiscordComponent(b.prompt.components[i]!));
}
export function requirePromptReady(server: PortableResidentLifecycle, generation: bigint): void {
  const state = PortableResidentLifecycle.prototype.lifecycleSnapshot.call(server);
  if (state.generation !== generation || !state.healthy || state.quarantined || state.restartPending) throw new PromptRedisplayChangedError();
}
function actor(channel: bigint, user: bigint): void {
  for (const id of [channel, user]) if (typeof id !== 'bigint' || id < 0n || id >= 1n << 64n) throw new TypeError('Expected u64 prompt actor');
}
/** Rebuild an existing occurrence. Unavailable diagnostics contain only fixed
 * reasons, never question text/command contents or an unsupported method value. */
export async function prepareOneServerPrompt(database: string, server: PortableResidentLifecycle, input: PendingServerRequest,
  generation: bigint, channel: bigint, user: bigint): Promise<PreparedPrompt> {
  actor(channel, user); const request = clonePendingServerRequest(input); requirePromptReady(server, generation);
  let prompt: ServerPrompt, unavailable = false;
  try {
    const authority = await verifyPromptAuthority(database, server, request, generation); authority.requireActor(channel, user);
    prompt = buildServerPrompt(request, generation);
  } catch (error) {
    if (!(error instanceof PromptAuthorityError) && !(error instanceof ServerPromptError)) throw error;
    const reason = error instanceof ServerPromptError && error.kind === 'Unsupported' ? 'unsupported app-server request method' : error.message;
    prompt = Object.freeze({threadId: extractThreadId(request.params) ?? '', text: `Cannot display this pending request: ${reason}`, components: Object.freeze([])});
    unavailable = true;
  }
  requirePromptReady(server, generation);
  const prepared = Object.freeze({request, generation, prompt, unavailable}); owned.add(prepared); return prepared;
}
export async function prepareServerPrompts(database: string, server: PortableResidentLifecycle, thread: string,
  channel: bigint, user: bigint): Promise<readonly PreparedPrompt[]> {
  requireDiscordText(thread); actor(channel, user);
  const generation = PortableResidentLifecycle.prototype.generation.call(server); requirePromptReady(server, generation);
  const requests = PortableResidentLifecycle.prototype.pendingServerRequests.call(server, thread), prompts: PreparedPrompt[] = [];
  for (const request of requests) prompts.push(await prepareOneServerPrompt(database, server, request, generation, channel, user));
  requirePromptReady(server, generation);
  if (PortableResidentLifecycle.prototype.generation.call(server) !== generation) throw new PromptRedisplayChangedError();
  const current = PortableResidentLifecycle.prototype.pendingServerRequests.call(server, thread);
  if (current.length !== requests.length
    || !current.every((value, i) => pendingServerRequestEqual(value, requests[i]!))) throw new PromptRedisplayChangedError();
  return Object.freeze(prompts);
}
