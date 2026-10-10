import {types} from 'node:util';
import {usingInitializedStore} from './owned-scope.ts';
import {decodeOptionalI64} from './sqlite-values.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {requireDiscordText} from '../discord/text.ts';
export const HISTORY_POLL_TARGET_LIMIT=50;
export type HistoryTargetSource='Startup'|'Allowed'|'MirrorProject'|'MirrorThread';
export interface HistoryPollTarget {readonly source:HistoryTargetSource;readonly channelId:bigint}
const u64=(value:unknown):bigint=>{if(typeof value!=='bigint'||value<0n||value>=1n<<64n)throw new TypeError('Expected u64 history channel');return value;};
/** Source priority: startup, numerically sorted allowed IDs, project recency,
 * thread recency. This limits one polling target list, not saved conversations.
 * Lazy row iteration stops at 50 unique nonzero IDs; later bad rows are unread.
 * Uses initialized owned store; DatabaseSync is not offloaded here. */
export async function historyPollTargets(path:string,allowedChannelIds:ReadonlySet<bigint>,startupChannelId:bigint|null):Promise<readonly HistoryPollTarget[]>{
 requireDiscordText(path);if(startupChannelId!==null)u64(startupChannelId);
 if(allowedChannelIds===null||typeof allowedChannelIds!=='object'||types.isProxy(allowedChannelIds))throw new TypeError('Expected native channel set');
 const allowed:bigint[]=[];Set.prototype.forEach.call(allowedChannelIds,(id:unknown)=>allowed.push(u64(id)));allowed.sort((a,b)=>a<b?-1:a>b?1:0);
 return usingInitializedStore(path,db=>{
  const targets:HistoryPollTarget[]=[],seen=new Set<bigint>();
  const add=(source:HistoryTargetSource,id:bigint|null)=>{if(id===null||id===0n||targets.length===HISTORY_POLL_TARGET_LIMIT||seen.has(id))return;seen.add(id);targets.push(Object.freeze({source,channelId:id}));};
  add('Startup',startupChannelId);for(const id of allowed)add('Allowed',id);
  const collect=(source:HistoryTargetSource,sql:string)=>{if(targets.length===HISTORY_POLL_TARGET_LIMIT)return;const statement=db.prepare(sql);statement.setReadBigInts(true);for(const row of statement.iterate()){const id=decodeOptionalI64(row.id,'history channel');if(id!==null&&id<0n)throw new StoreIntegrityError('Negative Discord history channel');add(source,id);if(targets.length===HISTORY_POLL_TARGET_LIMIT)break;}};
  collect('MirrorProject','SELECT discord_channel_id AS id FROM mirror_projects ORDER BY updated_at DESC, project_key ASC');
  collect('MirrorThread','SELECT discord_thread_id AS id FROM mirror_threads ORDER BY updated_at DESC, codex_thread_id ASC');
  return Object.freeze(targets);
 });
}
