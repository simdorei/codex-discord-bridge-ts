import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {getGoal, readThreadWithTimeout, type AppRequest} from '../../app-server/requests.ts';
import {parseThreadGoalStatus} from '../../app-server/goal.ts';
import {parseThreadTurnStates} from '../../app-server/outcomes.ts';
import {serdeField} from '../../app-server/value.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {ComponentWorkerError} from './errors.ts';
import type {StoredAsyncQuestion} from '../../store/async-question-read.ts';
export type AsyncChoiceIdentity = Pick<StoredAsyncQuestion, 'runtimeId' | 'generation' | 'threadId' | 'turnId'>;
export interface AsyncChoicePreflight {readonly mode: 'steer' | 'start'; readonly baselineTurnIds: readonly string[]}
function invalid(message: string): never {throw new ComponentWorkerError('AsyncQuestion', message);}
async function execute(server: PortableResidentLifecycle, request: AppRequest, generation: bigint): Promise<unknown> {
  try {return await PortableResidentLifecycle.prototype.execute.call(server, request, generation);} catch (error) {throw new ComponentWorkerError('AppServer', error);}
}
/** Read-only eligibility for one original question. The caller holds its target
 * lock and must repeat this exact preflight at actual dispatch; this is not a
 * persistent grant, a claim, a start or an automatic successor selection. */
export async function preflightAsyncChoice(server: PortableResidentLifecycle, input: AsyncChoiceIdentity): Promise<AsyncChoicePreflight> {
  const runtimeId = gatewayOwnField(input, 'runtimeId'), generation = gatewayOwnField(input, 'generation'), threadId = gatewayOwnField(input, 'threadId'), turnId = gatewayOwnField(input, 'turnId');
  for (const text of [runtimeId, threadId, turnId]) requireDiscordText(text);
  if (typeof generation !== 'bigint' || generation < -(1n << 63n) || generation >= 1n << 63n) throw new TypeError('Expected signed question generation');
  const thread = threadId as string, turn = turnId as string;
  const snapshot = PortableResidentLifecycle.prototype.lifecycleSnapshot.call(server);
  if (!snapshot.healthy || snapshot.quarantined || snapshot.restartPending || server.instanceId !== runtimeId || snapshot.generation !== generation) return invalid('질문을 만든 기존 연결이 변경되었거나 준비되지 않았습니다. 답변하지 않았습니다.');
  const active = PortableResidentLifecycle.prototype.activeTurnId.call(server, thread);
  if (active !== null) {
    if (active !== turn) return invalid('새 작업이 이미 시작되어 이전 질문의 버튼은 만료되었습니다.');
    return Object.freeze({mode: 'steer', baselineTurnIds: Object.freeze([])});
  }
  const result = await execute(server, {method: 'thread/turns/list', params: {threadId: thread, limit: 1n, sortDirection: 'desc', itemsView: 'full'}, timeoutMs: 8000}, generation);
  const latest = serdeField(result, 'data');
  if (!Array.isArray(latest)) return invalid('최신 작업 기록을 확인할 수 없어 답변하지 않았습니다.');
  if (latest.length !== 1 || serdeField(latest[0], 'id') !== turn || serdeField(latest[0], 'status') !== 'completed') return invalid('질문의 원래 작업이 마지막 완료 작업인지 확인되지 않았습니다. 이전 질문을 새 작업에 전달하지 않습니다.');
  const goal = await execute(server, getGoal(thread), generation);
  let goalStatus;
  try {goalStatus = parseThreadGoalStatus(goal, thread);} catch (error) {return invalid(passiveErrorText(error, 'invalid thread goal'));}
  if (goalStatus === 'Active') return invalid('목표 작업이 계속 실행 중입니다. 원래 작업이 활성 상태일 때 답하거나 새 메시지로 요청해 주세요.');
  const history = await execute(server, readThreadWithTimeout(thread, true, 8000), generation); let states: ReturnType<typeof parseThreadTurnStates>;
  try {states = parseThreadTurnStates(history, thread);} catch (error) {return invalid(passiveErrorText(error, 'invalid thread history'));}
  const turns = serdeField(serdeField(history, 'thread'), 'turns');
  if (!Array.isArray(turns) || turns.length !== states.size || states.get(turn)?.status !== 'Completed' || [...states.values()].some(state => state.status === 'InProgress')) return invalid('async answer history is incomplete or changed; no new turn started');
  return Object.freeze({mode: 'start', baselineTurnIds: Object.freeze([...states.keys()])});
}
