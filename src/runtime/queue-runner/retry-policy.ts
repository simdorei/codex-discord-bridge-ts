export function retryDelaySeconds(count: bigint): number {
  return count <= 0n ? 0 : count >= 6n ? 900 : [0, 30, 60, 120, 240, 480][Number(count)]!;
}
export function pendingRetryDueAt(count: bigint, error: string, updatedAt: number): number | null {
  if (count <= 0n || error === "" || !Number.isFinite(updatedAt)) return null;
  const due = updatedAt + retryDelaySeconds(count);
  return Number.isFinite(due) ? due : null;
}
export function pendingRetryIsDue(count: bigint, error: string, updatedAt: number, now: number): boolean {
  const due = pendingRetryDueAt(count, error, updatedAt);
  return due === null || (Number.isFinite(now) && now >= due);
}

