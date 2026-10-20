import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {usingInitializedStore,withStoreTransaction,commitStore,rollbackStore} from './owned-scope.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {receiptRow,receiptExists,receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeI64,decodeOptionalI64} from './sqlite-values.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {requireDiscordText} from '../discord/text.ts';

/** Durable creation custody. A confirmed remote ID is retained until exact binding.
 * A bound category receipt can be replaced only by the runtime after a fresh,
 * exact-ID 404. These store functions do not themselves prove remote absence. */
export interface MirrorContainerReceipt {
 readonly kind:string;readonly key:string;readonly token:string;readonly guild:bigint;
 readonly parent:bigint|null;readonly expected:string;readonly phase:string;readonly channel:bigint|null;
}
export function requireContainer(condition:boolean,message:string):asserts condition {
 if(!condition)throw new StoreIntegrityError(message);
}
export function containerI64(value:unknown):bigint {
 if(typeof value!=='bigint'||value<-(1n<<63n)||value>=1n<<63n)throw new TypeError('Expected i64 container identity');return value;
}
export function ownContainerReceipt(input:MirrorContainerReceipt):MirrorContainerReceipt {
 const v=cloneOwnedSerdeValue(input) as MirrorContainerReceipt;
 if(v===null||typeof v!=='object'||Array.isArray(v))throw new TypeError('Expected container receipt');
 for(const k of ['kind','key','token','guild','parent','expected','phase','channel'])if(!Object.hasOwn(v,k))throw new TypeError('Expected complete own-data container receipt');
 for(const k of ['kind','key','token','expected','phase'] as const)requireDiscordText(v[k]);
 containerI64(v.guild);if(v.parent!==null)containerI64(v.parent);if(v.channel!==null)containerI64(v.channel);return v;
}
const selection=`kind,scope_key,token,guild_id,parent_id,expected_json,phase,channel_id,${receiptTextColumns('kind','scope_key','token','expected_json','phase')}`;
function decode(row:Record<string,unknown>):MirrorContainerReceipt {
 return Object.freeze({kind:receiptText(row,'kind')!,key:receiptText(row,'scope_key')!,token:receiptText(row,'token')!,guild:decodeI64(row.guild_id,'guild_id'),parent:decodeOptionalI64(row.parent_id,'parent_id'),expected:receiptText(row,'expected_json')!,phase:receiptText(row,'phase')!,channel:decodeOptionalI64(row.channel_id,'channel_id')});
}
export function loadContainerIn(db:DatabaseSync,kind:string,key:string):MirrorContainerReceipt|null {
 const row=receiptRow(db,`SELECT ${selection} FROM cdr_mirror_container_creations WHERE kind=? AND scope_key=?`,kind,key);return row===undefined?null:decode(row);
}
export function containerRecordsIn(db:DatabaseSync):readonly MirrorContainerReceipt[] {
 const q=db.prepare(`SELECT ${selection} FROM cdr_mirror_container_creations ORDER BY kind,scope_key`);q.setReadBigInts(true);return q.all().map(decode);
}
export function expectedContainerMapping(receipt:MirrorContainerReceipt):readonly (readonly [string,bigint])[] {
 let v:unknown;try{v=parseSerdeValue(receipt.expected);}catch{throw new StoreIntegrityError('invalid container creation mapping snapshot');}
 requireContainer(Array.isArray(v),'invalid container creation mapping snapshot');
 const out:(readonly [string,bigint])[]=[];
 for(const item of v){requireContainer(Array.isArray(item)&&item.length===2&&typeof item[0]==='string'&&typeof item[1]==='bigint'&&item[1]>=-(1n<<63n)&&item[1]<(1n<<63n),'invalid container creation mapping snapshot');out.push(Object.freeze([item[0],item[1]] as const));}
 return Object.freeze(out);
}
export function containerReceiptEqual(a:MirrorContainerReceipt|null,b:MirrorContainerReceipt|null):boolean {
 return a===null?b===null:b!==null&&a.kind===b.kind&&a.key===b.key&&a.token===b.token&&a.guild===b.guild&&a.parent===b.parent&&a.expected===b.expected&&a.phase===b.phase&&a.channel===b.channel;
}
export function checkContainerExactIn(db:DatabaseSync,r:MirrorContainerReceipt):void {
 requireContainer(containerReceiptEqual(loadContainerIn(db,r.kind,r.key),r),'container creation custody changed; intent retained');
}
export function confirmedContainerChannel(r:MirrorContainerReceipt):bigint {
 requireContainer(r.channel!==null&&r.channel>0n&&(r.phase==='confirmed'||r.phase==='bound'),'container creation outcome is unknown; creation will not be repeated');return r.channel;
}
export function checkContainerCleanupIn(db:DatabaseSync,r:MirrorContainerReceipt):void {
 const ids=[...(r.parent===null?[]:[r.parent]),...(r.channel===null?[]:[r.channel]),...expectedContainerMapping(r).map(([,id])=>id)];
 for(const id of ids)requireContainer(!receiptExists(db,`SELECT EXISTS(SELECT 1 FROM cdr_cleanup_fences f WHERE f.channel_id=? OR EXISTS(SELECT 1 FROM mirror_threads t WHERE t.discord_channel_id=? AND (f.channel_id=t.discord_thread_id OR f.target_thread_id=t.codex_thread_id))) AS held`,id,id),'container creation is blocked by room cleanup');
}
export function attemptContainerIn(db:DatabaseSync,r:MirrorContainerReceipt,previous:MirrorContainerReceipt|null):void {
 let changed:number|bigint;
 if(previous!==null){checkContainerExactIn(db,previous);requireContainer(previous.kind==='category'&&previous.phase==='bound','only an authoritatively missing bound category may be replaced');checkContainerCleanupIn(db,previous);
  changed=db.prepare("UPDATE cdr_mirror_container_creations SET token=?,phase='attempted',channel_id=NULL WHERE kind='category' AND scope_key=? AND token=? AND phase='bound'").run(r.token,r.key,previous.token).changes;
 }else{requireContainer(loadContainerIn(db,r.kind,r.key)===null,'container creation is already claimed');changed=db.prepare("INSERT INTO cdr_mirror_container_creations(kind,scope_key,token,guild_id,parent_id,expected_json,phase,channel_id) VALUES(?,?,?,?,?,?,'attempted',NULL)").run(r.kind,r.key,r.token,r.guild,r.parent,r.expected).changes;}
 requireContainer(BigInt(changed)===1n,'container creation intent was not stored');checkContainerExactIn(db,r);checkContainerCleanupIn(db,r);
}
/** Keep the known returned ID even if a cleanup fence appeared after dispatch.
 * Cleanup is checked by the later binding, not used to discard confirmation. */
export async function confirmMirrorContainer(path:string,input:MirrorContainerReceipt,channel:bigint):Promise<MirrorContainerReceipt> {
 requireDiscordText(path);containerI64(channel);const r=ownContainerReceipt(input);
 requireContainer(channel>0n&&r.phase==='attempted'&&r.channel===null,'invalid container creation confirmation');
 return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  checkContainerExactIn(db,r);const confirmed=Object.freeze({...r,phase:'confirmed',channel});
  const changed=db.prepare("UPDATE cdr_mirror_container_creations SET phase='confirmed',channel_id=? WHERE kind=? AND scope_key=? AND token=? AND phase='attempted' AND channel_id IS NULL").run(channel,r.kind,r.key,r.token).changes;
  requireContainer(BigInt(changed)===1n,'container creation confirmation was not stored');checkContainerExactIn(db,confirmed);return commitStore(confirmed);
 }));
}
export async function mirrorCategoryReceipt(path:string,guild:bigint):Promise<MirrorContainerReceipt|null> {
 requireDiscordText(path);containerI64(guild);return usingInitializedStore(path,db=>withStoreTransaction(db,'DEFERRED',()=>{
  const r=loadContainerIn(db,'category',guild.toString());if(r===null)return rollbackStore(null);
  requireContainer(r.guild===guild&&r.parent===null&&expectedContainerMapping(r).length===0,'category creation scope changed');confirmedContainerChannel(r);checkContainerCleanupIn(db,r);return rollbackStore(r);
 }));
}
export async function beginMirrorCategory(path:string,guild:bigint,input:MirrorContainerReceipt|null):Promise<MirrorContainerReceipt> {
 requireDiscordText(path);containerI64(guild);requireContainer(guild>0n,'invalid category creation scope');const previous=input===null?null:ownContainerReceipt(input);
 const r:MirrorContainerReceipt=Object.freeze({kind:'category',key:guild.toString(),token:randomUUID(),guild,parent:null,expected:'[]',phase:'attempted',channel:null});
 if(previous!==null)requireContainer(previous.kind===r.kind&&previous.key===r.key&&previous.guild===guild&&previous.parent===null&&previous.expected==='[]','category replacement scope changed');
 return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{attemptContainerIn(db,r,previous);return commitStore(r);}));
}
export async function bindMirrorCategory(path:string,input:MirrorContainerReceipt):Promise<void> {
 requireDiscordText(path);const r=ownContainerReceipt(input);requireContainer(r.kind==='category','invalid category binding');confirmedContainerChannel(r);
 return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  checkContainerExactIn(db,r);checkContainerCleanupIn(db,r);
  if(r.phase!=='bound'){
   const changed=db.prepare("UPDATE cdr_mirror_container_creations SET phase='bound' WHERE kind='category' AND scope_key=? AND token=? AND phase='confirmed' AND channel_id=?").run(r.key,r.token,r.channel).changes;
   requireContainer(BigInt(changed)===1n,'category binding was not stored');const bound=Object.freeze({...r,phase:'bound'});checkContainerExactIn(db,bound);checkContainerCleanupIn(db,bound);
  }return commitStore(undefined);
 }));
}
