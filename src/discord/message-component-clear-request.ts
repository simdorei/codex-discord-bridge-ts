/** Narrow source update_message(channel,message).components(Some(&[])) profile. */
export function messageComponentClearResource(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const match = /^channels\/([1-9][0-9]{0,19})\/messages\/([1-9][0-9]{0,19})$/u.exec(path);
  if (match === null || match[0] !== path || BigInt(match[1]!) >= 1n << 64n || BigInt(match[2]!) >= 1n << 64n) return null;
  return 'channels/' + match[1];
}
export function clearMessageComponentsRequest(channel: bigint, message: bigint) {
  for (const id of [channel, message]) if (typeof id !== 'bigint' || id <= 0n || id >= 1n << 64n) throw new TypeError('Expected nonzero Discord message identity');
  return Object.freeze({method: 'PATCH' as const, path: `channels/${channel}/messages/${message}`, body: '{"components":[]}'});
}
