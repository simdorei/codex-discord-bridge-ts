import type {DatabaseSync} from 'node:sqlite';
import {usingInitializedStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {readMirrorCreationIn,finishMirrorCreationIn,mirrorThreadChannelsIn} from './mirror-creation.ts';
import {receiptExists,receiptRow,receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {MirrorMappingChangedError} from './queue-enqueue.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {requireDiscordText} from '../discord/text.ts';
export interface MirrorThreadUpdate {readonly threadId:string;readonly projectKey:string;readonly title:string;readonly parentId:bigint;readonly channelId:bigint;readonly now:number}
function integer(value:unknown):bigint {if(typeof value!=='bigint'||value<-(1n<<63n)||value>=1n<<63n)throw new TypeError('Expected i64 mirror mapping identity');return value;}
function pair(input:readonly [bigint,bigint]|null):readonly [bigint,bigint]|null {if(input===null)return null;const value=cloneOwnedSerdeValue(input);if(!Array.isArray(value)||value.length!==2)throw new TypeError('Expected mapping pair');return Object.freeze([integer(value[0]),integer(value[1])] as const);}
export async function mirrorThreadChannels(path:string,thread:string):Promise<readonly [bigint,bigint]|null>{requireDiscordText(path);requireDiscordText(thread);return usingInitializedStore(path,db=>mirrorThreadChannelsIn(db,thread));}
/** Source first-row query, including its zero/null fast path. Atomic commit below
 * deliberately checks the full project identity multiset rather than this lookup. */
export async function mirrorProjectForChannel(path:string,channel:bigint|null):Promise<readonly [string,string]|null> {
 requireDiscordText(path);if(channel===null)return null;integer(channel);if(channel===0n)return null;return usingInitializedStore(path,db=>{const row=receiptRow(db,`SELECT project_key,project_name,${receiptTextColumns('project_key','project_name')} FROM mirror_projects WHERE discord_channel_id=?`,channel);return row===undefined?null:Object.freeze([receiptText(row,'project_key')!,receiptText(row,'project_name')!] as const);});
}
function projectKeys(db:DatabaseSync,parent:bigint):string[] {const q=db.prepare(`SELECT project_key,${receiptTextColumns('project_key')} FROM mirror_projects WHERE discord_channel_id=?`);q.setReadBigInts(true);return [...q.iterate(parent)].map(row=>receiptText(row,'project_key')!);}
/** Exact new-room mapping CAS and creation-custody consumption share one IMMEDIATE
 * transaction. It never repeats or rolls back a remote Discord create. */
export async function commitNewThreadSync(path:string,input:MirrorThreadUpdate,expectedInput:readonly [bigint,bigint]|null,projectKey:string|null):Promise<void> {
 requireDiscordText(path);const u=cloneOwnedSerdeValue(input) as MirrorThreadUpdate;for(const text of [u.threadId,u.projectKey,u.title])requireDiscordText(text);integer(u.parentId);integer(u.channelId);if(typeof u.now!=='number')throw new TypeError('Expected f64 mapping timestamp');const expected=pair(expectedInput);if(projectKey!==null)requireDiscordText(projectKey);
 return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  const keys=projectKeys(db,u.parentId);if(projectKey===null?keys.length!==0:keys.length!==1||keys[0]!==projectKey)throw new StoreIntegrityError(`new-thread project mapping changed for channel ${u.parentId}; created room ${u.channelId} retained without attaching or retrying`);
  if(receiptExists(db,'SELECT EXISTS(SELECT 1 FROM mirror_threads WHERE discord_thread_id=? AND codex_thread_id<>?) AS held',u.channelId,u.threadId))throw new StoreIntegrityError(`Discord room ${u.channelId} already belongs to another Codex thread; mapping unchanged`);
  const actual=mirrorThreadChannelsIn(db,u.threadId);if(actual===null?expected!==null:expected===null||actual[0]!==expected[0]||actual[1]!==expected[1])throw new MirrorMappingChangedError(u.channelId,u.threadId,null);
  const creation=readMirrorCreationIn(db,u.threadId);
  db.prepare(`INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(codex_thread_id) DO UPDATE SET project_key=excluded.project_key,thread_title=excluded.thread_title,discord_channel_id=excluded.discord_channel_id,discord_thread_id=excluded.discord_thread_id,updated_at=excluded.updated_at`).run(u.threadId,u.projectKey,u.title,u.parentId,u.channelId,u.now);
  finishMirrorCreationIn(db,u.threadId,u.parentId,u.channelId,expected,creation);return commitStore(undefined);
 }));
}
