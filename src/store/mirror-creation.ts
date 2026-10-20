import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {usingInitializedStore,withStoreTransaction,commitStore,rollbackStore} from './owned-scope.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {receiptRow,receiptExists,receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeI64,decodeOptionalI64} from './sqlite-values.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {rustTrim} from '../app-server/value.ts';
export interface MirrorCreationScope {readonly thread:string;readonly guild:bigint;readonly parent:bigint;readonly expected:readonly [bigint,bigint]|null}
export interface MirrorCreationRecord {readonly token:string;readonly guild:bigint;readonly parent:bigint;readonly expectedParent:bigint|null;readonly expectedChannel:bigint|null;readonly phase:string;readonly channel:bigint|null}
const invalid=(message:string):never=>{throw new StoreIntegrityError(message);};
function integer(value:unknown):bigint {if(typeof value!=='bigint'||value<-(1n<<63n)||value>=1n<<63n)throw new TypeError('Expected i64 mirror identity');return value;}
function scopeOf(input:MirrorCreationScope):MirrorCreationScope {
 const v=cloneOwnedSerdeValue(input) as MirrorCreationScope;requireDiscordText(v.thread);integer(v.guild);integer(v.parent);
 if(v.expected!==null){if(!Array.isArray(v.expected)||v.expected.length!==2)throw new TypeError('Expected mirror mapping pair');integer(v.expected[0]);integer(v.expected[1]);Object.freeze(v.expected);}return Object.freeze(v);
}
export function readMirrorCreationIn(db:DatabaseSync,thread:string):MirrorCreationRecord|null {
 requireDiscordText(thread);const row=receiptRow(db,`SELECT token,guild_id,parent_id,expected_parent_id,expected_channel_id,phase,channel_id,${receiptTextColumns('token','phase')} FROM cdr_mirror_thread_creations WHERE thread_id=?`,thread);
 return row===undefined?null:Object.freeze({token:receiptText(row,'token')!,guild:decodeI64(row.guild_id,'guild'),parent:decodeI64(row.parent_id,'parent'),expectedParent:decodeOptionalI64(row.expected_parent_id,'expected_parent'),expectedChannel:decodeOptionalI64(row.expected_channel_id,'expected_channel'),phase:receiptText(row,'phase')!,channel:decodeOptionalI64(row.channel_id,'channel')});
}
export function mirrorThreadChannelsIn(db:DatabaseSync,thread:string):readonly [bigint,bigint]|null {
 requireDiscordText(thread);const row=receiptRow(db,'SELECT discord_channel_id,discord_thread_id FROM mirror_threads WHERE codex_thread_id=?',thread);return row===undefined?null:Object.freeze([decodeI64(row.discord_channel_id,'parent'),decodeI64(row.discord_thread_id,'channel')] as const);
}
function pairEqual(a:readonly [bigint,bigint]|null,b:readonly [bigint,bigint]|null):boolean{return a===null?b===null:b!==null&&a[0]===b[0]&&a[1]===b[1];}
function checkScope(r:MirrorCreationRecord,s:MirrorCreationScope):void {if(r.guild!==s.guild||r.parent!==s.parent||r.expectedParent!==(s.expected?.[0]??null)||r.expectedChannel!==(s.expected?.[1]??null))invalid('mirror creation scope changed; intent retained');}
function checkCleanup(db:DatabaseSync,s:MirrorCreationScope):void {if(receiptExists(db,'SELECT EXISTS(SELECT 1 FROM cdr_cleanup_fences WHERE channel_id=? OR channel_id=? OR target_thread_id=?) AS held',s.parent,s.expected?.[1]??null,s.thread))invalid('mirror creation is blocked by room cleanup');}
/** Unknown creation custody always blocks reuse, even when an old mapping returns. */
export async function confirmedMirrorCreation(path:string,input:MirrorCreationScope):Promise<bigint|null> {
 requireDiscordText(path);const s=scopeOf(input);return usingInitializedStore(path,db=>withStoreTransaction(db,'DEFERRED',()=>{
  const r=readMirrorCreationIn(db,s.thread);if(r===null)return rollbackStore(null);checkScope(r,s);checkCleanup(db,s);if(!pairEqual(mirrorThreadChannelsIn(db,s.thread),s.expected))invalid('mirror mapping changed during creation');
  if(r.phase==='confirmed'&&r.channel!==null&&r.channel>0n)return rollbackStore(r.channel);return invalid(`mirror creation outcome is unknown for ${s.thread}; creation will not be repeated`);
 }));
}
export async function beginMirrorCreation(path:string,input:MirrorCreationScope):Promise<string> {
 requireDiscordText(path);const s=scopeOf(input);if(rustTrim(s.thread)===''||s.guild<=0n||s.parent<=0n||(s.expected!==null&&(s.expected[0]<=0n||s.expected[1]<=0n)))invalid('invalid mirror creation scope');
 return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  if(readMirrorCreationIn(db,s.thread)!==null||!pairEqual(mirrorThreadChannelsIn(db,s.thread),s.expected))invalid('mirror creation already claimed or mapping changed');checkCleanup(db,s);const token=randomUUID();
  const inserted=db.prepare("INSERT INTO cdr_mirror_thread_creations(thread_id,token,guild_id,parent_id,expected_parent_id,expected_channel_id,phase) VALUES(?,?,?,?,?,?,'attempted')").run(s.thread,token,s.guild,s.parent,s.expected?.[0]??null,s.expected?.[1]??null).changes;
  const r=readMirrorCreationIn(db,s.thread)??invalid('mirror creation intent was not stored');checkScope(r,s);if(BigInt(inserted)!==1n||r.token!==token||r.phase!=='attempted'||r.channel!==null)invalid('mirror creation intent write was not exact');return commitStore(token);
 }));
}
/** Retain returned remote ID before mapping. Cleanup/mapping drift does not erase a
 * known remote result; those conditions are checked before mapping permission. */
export async function confirmMirrorCreation(path:string,input:MirrorCreationScope,token:string,channel:bigint):Promise<void> {
 requireDiscordText(path);requireDiscordText(token);integer(channel);const s=scopeOf(input);return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  let r=readMirrorCreationIn(db,s.thread)??invalid('mirror creation intent disappeared');checkScope(r,s);if(channel<=0n||r.token!==token||r.phase!=='attempted'||r.channel!==null)invalid('mirror creation confirmation lost ownership');
  const changed=db.prepare("UPDATE cdr_mirror_thread_creations SET phase='confirmed',channel_id=? WHERE thread_id=? AND token=? AND phase='attempted' AND channel_id IS NULL").run(channel,s.thread,token).changes;
  r=readMirrorCreationIn(db,s.thread)??invalid('mirror creation confirmation disappeared');checkScope(r,s);if(BigInt(changed)!==1n||r.token!==token||r.phase!=='confirmed'||r.channel!==channel)invalid('mirror creation confirmation was not stored');return commitStore(undefined);
 }));
}
function recordEqual(a:MirrorCreationRecord|null,b:MirrorCreationRecord|null):boolean {return a===null?b===null:b!==null&&a.token===b.token&&a.guild===b.guild&&a.parent===b.parent&&a.expectedParent===b.expectedParent&&a.expectedChannel===b.expectedChannel&&a.phase===b.phase&&a.channel===b.channel;}
/** Called only inside the mapping CAS transaction. No transaction/connection
 * management here, and no authority to create a mapping independently. */
export function finishMirrorCreationIn(db:DatabaseSync,thread:string,parent:bigint,channel:bigint,expected:readonly [bigint,bigint]|null,original:MirrorCreationRecord|null):void {
 if(!db.isTransaction)throw new StoreIntegrityError('mirror creation completion requires mapping transaction');requireDiscordText(thread);integer(parent);integer(channel);
 if(!recordEqual(readMirrorCreationIn(db,thread),original))invalid('mirror creation custody changed during mapping write');if(original===null)return;
 const s=scopeOf({thread,guild:original.guild,parent,expected});checkScope(original,s);checkCleanup(db,s);
 if(original.phase!=='confirmed'||original.channel!==channel||!pairEqual(mirrorThreadChannelsIn(db,thread),[parent,channel]))invalid('mirror creation mapping was not confirmed');
 const changed=db.prepare("DELETE FROM cdr_mirror_thread_creations WHERE thread_id=? AND token=? AND phase='confirmed' AND channel_id=?").run(thread,original.token,channel).changes;
 if(BigInt(changed)!==1n||readMirrorCreationIn(db,thread)!==null||!pairEqual(mirrorThreadChannelsIn(db,thread),[parent,channel]))invalid('mirror creation completion was not stored');checkCleanup(db,s);
}
