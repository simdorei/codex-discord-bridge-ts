/** Fixed, unpaginated Rust history request. No caller-controlled cursor or limit. */
export const HISTORY_HTTP_MAX_BYTES=2*1024*1024;
export function historyChannelResource(path:unknown):string|null{
 if(typeof path!=='string')return null;const m=/^channels\/([1-9][0-9]{0,19})\/messages\?limit=10$/u.exec(path);
 return m!==null&&m[0]===path&&BigInt(m[1]!)<(1n<<64n)?'channels/'+m[1]:null;
}
export function historyMessagePath(id:bigint):string{
 if(typeof id!=='bigint'||id<=0n||id>=(1n<<64n))throw new TypeError('Expected nonzero u64 history channel');
 return 'channels/'+id+'/messages?limit=10';
}
