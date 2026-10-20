import {types} from 'node:util';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {createOwnedWorkQueue} from '../../core/owned-work-queue.ts';
import {AdmissionPermit} from '../../admission/drain-gate.ts';
import {isRoutedInteractionWork, type RoutedInteractionWork} from '../../discord/interaction-routing.ts';
import {snapshotBusyChoice, type BusyChoice} from '../../store/busy-choice.ts';
export interface InboundInteractionWork {
  readonly applicationId: bigint;
  readonly interactionId: bigint;
  readonly channelId: bigint;
  readonly userId: bigint;
  readonly sourceMessageId: bigint | null;
  readonly interactionToken: string;
  readonly work: RoutedInteractionWork;
  readonly processingMode: 'Execute' | 'ConfirmationOnly';
  readonly custodyDatabase: string;
  readonly custodyIngressId: string;
  readonly authorizedBusyChoice: Readonly<BusyChoice> | null;
  readonly admissionPermit: AdmissionPermit | null;
}
const release = AdmissionPermit.prototype.release;
export function releaseInboundInteractionWork(work: InboundInteractionWork): void {
  if (work.admissionPermit !== null) release.call(work.admissionPermit);
}
const queues = new WeakSet<object>();
/** Source service capacity is 64. Smaller capacities are supported for tests.
 * A consumer must release each received item's permit after its actual work joins. */
export function createInteractionWorkQueue(capacity = 64) {
  const queue = createOwnedWorkQueue<InboundInteractionWork>(capacity, releaseInboundInteractionWork);
  queues.add(queue); return queue;
}
export type InteractionWorkQueue = ReturnType<typeof createInteractionWorkQueue>;
export function isInteractionWorkQueue(value: unknown): value is InteractionWorkQueue {
  return value !== null && typeof value === 'object' && queues.has(value);
}

export function snapshotInboundInteractionWork(input: InboundInteractionWork): InboundInteractionWork {
  const fields = ['applicationId', 'interactionId', 'channelId', 'userId', 'sourceMessageId', 'interactionToken', 'work', 'processingMode', 'custodyDatabase', 'custodyIngressId', 'authorizedBusyChoice', 'admissionPermit'] as const;
  const out = Object.fromEntries(fields.map(k => [k, gatewayOwnField(input, k)])) as unknown as InboundInteractionWork;
  for (const id of [out.applicationId, out.interactionId, out.channelId, out.userId, ...(out.sourceMessageId === null ? [] : [out.sourceMessageId])]) if (typeof id !== 'bigint' || id <= 0n || id >= 1n << 64n) throw new TypeError('Expected queued Discord identity');
  for (const text of [out.interactionToken, out.custodyDatabase, out.custodyIngressId]) requireDiscordText(text);
  if (!isRoutedInteractionWork(out.work) || !['Execute', 'ConfirmationOnly'].includes(out.processingMode)) throw new TypeError('Expected owned queued interaction');
  if (out.admissionPermit !== null && (typeof out.admissionPermit !== 'object' || types.isProxy(out.admissionPermit))) throw new TypeError('Expected admission permit');
  return Object.freeze({...out, authorizedBusyChoice: out.authorizedBusyChoice === null ? null : Object.freeze(snapshotBusyChoice(out.authorizedBusyChoice))});
}
