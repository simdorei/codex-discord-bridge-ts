import {types} from 'node:util';
import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {startTurn, steerTurn} from '../../app-server/requests.ts';
import {ownedRequestFailure} from '../../app-server/request-client.ts';
import {ownedResidentFailure} from '../../app-server/resident-state.ts';
import {isUsageLimitError} from '../../app-server/outcomes.ts';
import {serdeField} from '../../app-server/value.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {answerPrompt} from '../../store/async-question-body.ts';
import type {StoredAsyncQuestion} from '../../store/async-question-read.ts';
import {ControlTurnVerifier} from '../action-executor/control-turn.ts';
import type {InboundInteractionWork} from '../discord-dispatch/interaction-work.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
import {ComponentWorkerError} from './errors.ts';
import {asyncQuestionConfirmationPlan, type ConfirmationPlan} from './confirmation.ts';
import {preflightAsyncChoice, type AsyncChoicePreflight} from './async-choice-preflight.ts';
function invalid(message: string): never {throw new ComponentWorkerError('AsyncQuestion', message);}
async function stored<T>(run: () => Promise<T> | T): Promise<T> {try {return await run();} catch (error) {throw new ComponentWorkerError('Store', error);}}
const same = (a: AsyncChoicePreflight, b: AsyncChoicePreflight) => a.mode === b.mode && a.baselineTurnIds.length === b.baselineTurnIds.length && a.baselineTurnIds.every((v,i) => v === b.baselineTurnIds[i]);
async function dispatch(database: string, server: PortableResidentLifecycle, q: StoredAsyncQuestion, mode: AsyncChoicePreflight['mode'], prompt: string): Promise<void> {
  if (q.generation < 0n) return invalid('invalid question generation');
  let response: unknown;
  try {response = await PortableResidentLifecycle.prototype.execute.call(server, mode === 'steer' ? steerTurn(q.threadId, prompt, q.turnId) : startTurn(q.threadId, prompt), q.generation);}
  catch (error) {
    const remote = ownedRequestFailure(error), resident = ownedResidentFailure(error), message = passiveErrorText(error, 'app-server answer dispatch failed');
    if (mode === 'start' && remote?.kind === 'Remote' && isUsageLimitError(remote.data)) await stored(() => state.rejectUsageLimitAsyncQuestion(database, q.id, message));
    else if (remote?.kind === 'Remote' || resident?.kind === 'GenerationMismatch' || resident?.kind === 'GenerationQuarantined' || resident?.kind === 'DeadGenerationFence') await stored(() => state.rejectDefiniteAsyncQuestion(database, q.id, message));
    else await stored(() => state.recordAsyncQuestionError(database, q.id, message));
    throw new ComponentWorkerError('AppServer', error);
  }
  const accepted = mode === 'steer' ? serdeField(response, 'turnId') : serdeField(serdeField(response, 'turn'), 'id');
  if (typeof accepted !== 'string' || accepted === '') {
    await stored(() => state.recordAsyncQuestionError(database, q.id, 'app-server response omitted accepted turn identity; answer outcome held'));
    throw new ComponentWorkerError('ActionOutcomeIndeterminate', 'accepted turn identity missing');
  }
  await stored(() => state.confirmAsyncQuestionDispatch(database, q.id, accepted));
}
/** One-shot async choice: original target lock spans second store read, claim,
 * repeated preflight, exact dispatch guard and native write/confirmation. Unknown
 * acceptance stays dispatching; no generic retry or automatic Reserve exists. */
export async function handleAsyncChoice(work: Pick<InboundInteractionWork, 'sourceMessageId' | 'channelId' | 'userId' | 'processingMode'>,
  id: string, option: bigint, database: string, server: PortableResidentLifecycle, verifier: ControlTurnVerifier,
  notifyDeliveryReady: () => void, now: () => number = systemNow): Promise<ConfirmationPlan> {
  requireDiscordText(id); requireDiscordText(database);
  if (typeof option !== 'bigint' || option < 0n || option >= 1n << 64n) throw new TypeError('Expected 64-bit usize question option');
  if (typeof notifyDeliveryReady !== 'function' || types.isProxy(notifyDeliveryReady) || types.isAsyncFunction(notifyDeliveryReady) || types.isGeneratorFunction(notifyDeliveryReady)) throw new TypeError('Expected synchronous delivery notification');
  const messageId = gatewayOwnField(work, 'sourceMessageId'), channel = gatewayOwnField(work, 'channelId'), user = gatewayOwnField(work, 'userId'), processing = gatewayOwnField(work, 'processingMode');
  for (const value of [channel, user, ...(messageId === null ? [] : [messageId])]) if (typeof value !== 'bigint' || value <= 0n || value >= 1n << 64n) throw new TypeError('Expected Discord question actor');
  if (processing !== 'Execute' && processing !== 'ConfirmationOnly') throw new TypeError('Expected interaction processing mode');
  const before = await stored(() => state.getAsyncQuestion(database, id)); let lease;
  try {lease = await ControlTurnVerifier.prototype.lock.call(verifier, before.threadId);} catch (error) {return invalid(passiveErrorText(error, 'question target lock failed'));}
  try {
    const q = await stored(() => state.getAsyncQuestion(database, id)); if (messageId === null) throw new ComponentWorkerError('MissingSourceMessage');
    const message = String(messageId);
    if (q.channelId !== channel || q.ownerUserId !== user || q.messageId !== message || option >= BigInt(q.body.options.length)) return invalid('질문의 사용자·방·메시지·선택지가 일치하지 않아 답변하지 않았습니다.');
    await stored(() => state.requireCurrentAsyncQuestionMapping(database, q));
    if (q.state === 'submitted') {if (q.chosen !== option) throw new ComponentWorkerError('AlreadyHandled'); return asyncQuestionConfirmationPlan(q.id);}
    if (processing === 'ConfirmationOnly') throw new ComponentWorkerError('ActionUnconfirmed');
    if (q.state !== 'open') return invalid(`질문 답변 상태: ${q.state}. 자동 재전송하지 않습니다. ${q.error}`);
    const prepared = await preflightAsyncChoice(server, q);
    const prompt = await stored(() => answerPrompt({id:q.id,runtime_id:q.runtimeId,generation:q.generation,thread_id:q.threadId,turn_id:q.turnId,item_id:q.itemId,origin_job_id:q.originJobId,channel_id:q.channelId,owner_user_id:q.ownerUserId,body:q.body,message_id:message,chosen:option},option));
    await stored(() => state.beginAsyncQuestionDispatch(database, {id, runtime_id:server.instanceId, generation:q.generation, channel:q.channelId, actor:q.ownerUserId, message, option, mode:prepared.mode === 'steer' ? 'Steer' : 'Start', baseline_turn_ids:prepared.baselineTurnIds, prompt, now:readCustodyTimestamp(now)}));
    try {
      await stored(() => state.requireCurrentAsyncQuestionMapping(database, q));
      if (!same(await preflightAsyncChoice(server,q),prepared)) return invalid('질문의 원래 작업 상태가 변경되어 답변하지 않았습니다.');
      await stored(() => state.validateAsyncDispatchGuards(database,q.threadId));
    } catch (error) {await stored(() => state.rejectDefiniteAsyncQuestion(database,id,passiveErrorText(error,'question preflight changed')));throw error;}
    await dispatch(database,server,q,prepared.mode,prompt);invokeSynchronousVoid(notifyDeliveryReady,{});return asyncQuestionConfirmationPlan(q.id);
  } finally {lease.release();}
}
