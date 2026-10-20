import type { StoredQueueJob } from "../../src/store/queue-read.ts";

export function queueJob(overrides: Partial<StoredQueueJob> = {}): StoredQueueJob {
  return { jobId: "saved", targetThreadId: "target", channelId: 1n, ownerUserId: null,
    discordMessageId: null, appServerGeneration: 1n, executionGeneration: null,
    turnObservationGeneration: null, goalWaiting: false, prompt: "prompt", queued: true,
    ackSent: true, state: "Pending", attemptCount: 2n, turnId: null, baselineTurnIds: [],
    lastError: "", createdAt: 0, updatedAt: 0, ...overrides };
}
