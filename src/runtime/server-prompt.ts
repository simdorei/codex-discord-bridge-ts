import {clonePendingServerRequest, type PendingServerRequest} from '../app-server/server-request-state.ts';
import {extractThreadId} from '../app-server/identity.ts';
import {validateInputQuestions, inputOptionLabels} from '../app-server/input-validation.ts';
import {AppServerInvalidReplyError} from '../app-server/client-errors.ts';
import {serdeField, rustTrim} from '../app-server/value.ts';
import {boundApprovalButtonRow, boundInputButtonRow, requestFingerprint, ComponentError, type DiscordComponent} from '../discord/components.ts';
import {ServerRequestOccurrence} from '../protocol/ids.ts';
export interface ServerPrompt {readonly threadId: string; readonly text: string; readonly components: readonly DiscordComponent[]}
export type ServerPromptErrorKind = 'MissingThread' | 'Unsupported' | 'InvalidQuestions' | 'SecretInput' | 'Component';
export class ServerPromptError extends Error {
  readonly kind: ServerPromptErrorKind;
  constructor(kind: ServerPromptErrorKind, detail?: string, cause?: unknown) {
    super(kind === 'MissingThread' ? 'app-server request has no thread id' : kind === 'Unsupported' ? `unsupported app-server request method: ${detail}`
      : kind === 'InvalidQuestions' ? 'app-server input request has no valid questions' : kind === 'SecretInput' ? 'Secret input must be completed in the Codex app, not in Discord' : detail, {cause});
    this.name = 'ServerPromptError'; this.kind = kind;
  }
}
const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval']);
function detail(value: unknown): string | null {
  const text = typeof value === 'string' ? value : Array.isArray(value) ? value.filter(v => typeof v === 'string').join(' ') : null;
  if (text === null) return null; let bounded = '', count = 0;
  for (const char of rustTrim(text)) {if (count++ === 1000) break; bounded += char;}
  return bounded === '' ? null : bounded;
}
/** Pure rendering of an immutable pending occurrence. Does not record, authorize,
 * answer or deliver a server request. Secret questions never produce a UI. */
export function buildServerPrompt(input: PendingServerRequest, generation: bigint): ServerPrompt {
  if (typeof generation !== 'bigint' || generation < 0n || generation >= 1n << 64n) throw new TypeError('Expected u64 generation');
  const request = clonePendingServerRequest(input), thread = extractThreadId(request.params);
  if (thread === null) throw new ServerPromptError('MissingThread');
  const occurrence = ServerRequestOccurrence.prototype.asBytes.call(request.occurrence);
  try {
    if (approvalMethods.has(request.method) || (request.method === 'mcpServer/elicitation/request' && serdeField(request.params, 'mode') === 'url')) {
      let text = request.method;
      for (const key of ['reason', 'command', 'message']) {const candidate = detail(serdeField(request.params, key)); if (candidate !== null) {text = candidate; break;}}
      return Object.freeze({threadId: thread, text: `Approval required\nthread: ${thread}\nrequest: ${request.method}\ndetail: ${text}`,
        components: Object.freeze([boundApprovalButtonRow(thread, generation, occurrence, request.id)])});
    }
    if (request.method !== 'item/tool/requestUserInput') throw new ServerPromptError('Unsupported', request.method);
    let questions: readonly unknown[];
    try {questions = validateInputQuestions(request.params);} catch (error) {if (error instanceof AppServerInvalidReplyError) throw new ServerPromptError('InvalidQuestions', undefined, error); throw error;}
    const sections: string[] = [], optionsFor: (readonly (readonly [string, string])[])[] = [];
    for (let i = 0; i < questions.length; i++) {
      const question = questions[i]; if (serdeField(question, 'isSecret') === true) throw new ServerPromptError('SecretInput');
      const rawId = serdeField(question, 'id'), rawTitle = serdeField(question, 'question');
      if (typeof rawId !== 'string' || rustTrim(rawId) === '' || typeof rawTitle !== 'string' || rustTrim(rawTitle) === '') throw new ServerPromptError('InvalidQuestions');
      const options = inputOptionLabels(question).map((label, n) => [String(n + 1), label] as const); optionsFor.push(options);
      const rawOptions = serdeField(question, 'options'), lines = [`${i + 1}. ${rustTrim(rawTitle)} [${rustTrim(rawId)}]`];
      for (let j = 0; j < options.length; j++) {
        const description = Array.isArray(rawOptions) ? serdeField(rawOptions[j], 'description') : undefined;
        lines.push(`   ${j + 1}. ${options[j]![1]}${typeof description === 'string' && rustTrim(description) !== '' ? ' — ' + rustTrim(description) : ''}`);
      }
      sections.push(lines.join('\n'));
    }
    const components = questions.length === 1 && optionsFor[0]!.length !== 0 ? [boundInputButtonRow(thread, generation, occurrence, request.id, optionsFor[0]!)] : [];
    // Source example intentionally retains raw question IDs while display uses trim.
    const help = questions.length === 1 ? 'Reply in this channel with an option number, label, or free text.'
      : `Reply as question_id=value pairs, for example: ${questions.map(q => `${serdeField(q, 'id')}=1`).join('; ')}. Use | for multiple selections.`;
    const fingerprint = requestFingerprint(generation, occurrence, request.id);
    return Object.freeze({threadId: thread, components: Object.freeze(components), text: `Codex needs input\nthread: ${thread}\n${sections.join('\n')}\n${help}\nFor this exact request, copy the prefix and replace <answer>:\n[codex-reply:${fingerprint}] <answer>`});
  } catch (error) {if (error instanceof ComponentError) throw new ServerPromptError('Component', error.message, error); throw error;}
}
