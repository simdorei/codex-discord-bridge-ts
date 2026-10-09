import {createOwnedWorkQueue} from '../../core/owned-work-queue.ts';
import {AdmissionPermit} from '../../admission/drain-gate.ts';
import type {RoutedInteractionWork} from '../../discord/interaction-routing.ts';
import type {BusyChoice} from '../../store/busy-choice.ts';
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
