/** Lossless read-only Codex state row; paths are source string paths on this host. */
export interface ThreadInfo {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly updatedAt: bigint;
  readonly rolloutPath: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly tokensUsed: bigint | null;
  readonly archivedAt: bigint;
}
