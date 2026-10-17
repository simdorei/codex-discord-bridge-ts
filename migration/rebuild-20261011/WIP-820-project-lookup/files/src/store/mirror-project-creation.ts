import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import type {DatabaseSync} from 'node:sqlite';
import {usingInitializedStore,withStoreTransaction,commitStore,rollbackStore} from './owned-scope.ts';
import {receiptRow,receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeI64} from './sqlite-values.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {requireDiscordText} from '../discord/text.ts';
import {rustTrim} from '../app-server/value.ts';
import {requireContainer as require,containerI64,containerRecordsIn,expectedContainerMapping,containerReceiptEqual,confirmedContainerChannel,checkContainerCleanupIn,attemptContainerIn,type MirrorContainerReceipt} from './mirror-container-creation.ts';
export type MirrorProjectSnapshot=readonly (readonly [string,bigint])[];
export type MirrorProjectKeyMatch=(stored:string,key:string)=>boolean;
export interface MirrorProjectMatch {readonly channelId:bigint;readonly storedKey:string}
function comparator(fn:MirrorProjectKeyMatch):MirrorProjectKeyMatch {
 if(typeof fn!=='function'||types.isProxy(fn)||types.isAsyncFunction(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected synchronous project key matcher');
 return (a,b)=>{const result=fn(a,b);if(typeof result!=='boolean'){if(types.isPromise(result))void Promise.prototype.then.call(result,undefined,()=>undefined);throw new TypeError('Project key matcher must return boolean');}return result;};
}
function ownSnapshot(input:MirrorProjectSnapshot):MirrorProjectSnapshot {
 const value=cloneOwnedSerdeValue(input);if(!Array.isArray(value))throw new TypeError('Expected project snapshot');for(const pair of value){if(!Array.isArray(pair)||pair.length!==2)throw new TypeError('Expected project mapping pair');requireDiscordText(pair[0]);containerI64(pair[1]);}return value;
}
function equal(a:MirrorProjectSnapshot,b:MirrorProjectSnapshot):boolean {return a.length===b.length&&a.every(([key,id],i)=>key===b[i]![0]&&id===b[i]![1]);}
function snapshotIn(db:DatabaseSync,key:string,matches:MirrorProjectKeyMatch):MirrorProjectSnapshot {
 const q=db.prepare(`SELECT project_key,discord_channel_id,${receiptTextColumns('project_key')} FROM mirror_projects ORDER BY project_key`);q.setReadBigInts(true);
 // Decode the complete result before invoking the matcher, matching Rust collection.
 const rows=q.all().map(row=>Object.freeze([receiptText(row,'project_key')!,decodeI64(row.discord_channel_id,'discord_channel_id')] as const));return Object.freeze(rows.filter(([stored])=>matches(stored,key)));
}
function findIn(db:DatabaseSync,key:string,matches:MirrorProjectKeyMatch):MirrorContainerReceipt|null {
 let found:MirrorContainerReceipt|null=null;for(const r of containerRecordsIn(db))if(r.kind==='project'&&matches(r.key,key)){require(found===null,'multiple project creation claims; reconciliation required');found=r;}return found;
}
/** Exact match precedes full alias decoding. Alias fallback decodes every row
 * before choosing the first comparator match in updated_at descending order. */
export async function findMirrorProject(path:string,key:string|null,fn:MirrorProjectKeyMatch):Promise<MirrorProjectMatch|null> {
 requireDiscordText(path);if(key!==null)requireDiscordText(key);const canonical=rustTrim(key??'');if(canonical==='')return null;const matches=comparator(fn);
 return usingInitializedStore(path,db=>{
  const columns=`discord_channel_id,project_key,${receiptTextColumns('project_key')}`;
  const decode=(row:Record<string,unknown>):MirrorProjectMatch=>Object.freeze({channelId:decodeI64(row.discord_channel_id,'discord_channel_id'),storedKey:receiptText(row,'project_key')!});
  const exact=receiptRow(db,`SELECT ${columns} FROM mirror_projects WHERE project_key=?`,canonical);if(exact!==undefined)return decode(exact);
  const query=db.prepare(`SELECT ${columns} FROM mirror_projects ORDER BY updated_at DESC`);query.setReadBigInts(true);
  const rows=query.all().map(decode);return rows.find(row=>matches(row.storedKey,canonical))??null;
 });
}
export async function mirrorProjectSnapshot(path:string,key:string,fn:MirrorProjectKeyMatch):Promise<MirrorProjectSnapshot> {
 requireDiscordText(path);requireDiscordText(key);const matches=comparator(fn);return usingInitializedStore(path,db=>{const result=snapshotIn(db,key,matches);require(result.every(([,id])=>id>0n&&id===result[0]?.[1]),'project aliases have conflicting channel identities');return result;});
}
export async function mirrorProjectCreationReceipt(path:string,key:string,guild:bigint,parent:bigint,input:MirrorProjectSnapshot,fn:MirrorProjectKeyMatch):Promise<MirrorContainerReceipt|null> {
 requireDiscordText(path);requireDiscordText(key);containerI64(guild);containerI64(parent);const original=ownSnapshot(input),matches=comparator(fn);
 return usingInitializedStore(path,db=>withStoreTransaction(db,'DEFERRED',()=>{
  const r=findIn(db,key,matches);if(r===null)return rollbackStore(null);
  require(r.guild===guild&&r.parent===parent&&equal(expectedContainerMapping(r),original)&&equal(snapshotIn(db,key,matches),original),'project creation scope or mapping changed');confirmedContainerChannel(r);checkContainerCleanupIn(db,r);return rollbackStore(r);
 }));
}
export async function beginMirrorProject(path:string,key:string,guild:bigint,parent:bigint,input:MirrorProjectSnapshot,fn:MirrorProjectKeyMatch):Promise<MirrorContainerReceipt> {
 requireDiscordText(path);requireDiscordText(key);containerI64(guild);containerI64(parent);const original=ownSnapshot(input),matches=comparator(fn);
 require(rustTrim(key)!==''&&guild>0n&&parent>0n&&original.every(([,id])=>id>0n),'invalid project creation scope');
 const r:MirrorContainerReceipt=Object.freeze({kind:'project',key,token:randomUUID(),guild,parent,expected:serializeSerdeValue(original),phase:'attempted',channel:null});
 return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  require(findIn(db,key,matches)===null&&equal(snapshotIn(db,key,matches),original),'project creation already claimed or mapping changed');attemptContainerIn(db,r,null);
  require(equal(snapshotIn(db,key,matches),original)&&containerReceiptEqual(findIn(db,key,matches),r),'project mapping or unique creation claim changed during intent write');return commitStore(r);
 }));
}
export async function ensureMirrorProjectAdoptable(path:string,channel:bigint,parent:bigint):Promise<void> {
 requireDiscordText(path);containerI64(channel);containerI64(parent);return usingInitializedStore(path,db=>{for(const r of containerRecordsIn(db))require(!(r.kind==='project'&&(r.channel===channel||(r.channel===null&&r.parent===parent))),'project inventory candidate may belong to unresolved creation');});
}
function checkOtherClaims(db:DatabaseSync,key:string,channel:bigint,created:boolean,matches:MirrorProjectKeyMatch):void {
 const known=snapshotIn(db,key,matches).some(([,id])=>id===channel);
 for(const r of containerRecordsIn(db))if(r.kind==='project'&&!matches(r.key,key))require(r.channel!==channel&&(created||known||r.channel!==null),'project mapping would adopt unresolved creation from another scope');
}
function checkOtherMappings(db:DatabaseSync,key:string,channel:bigint,matches:MirrorProjectKeyMatch):void {
 const q=db.prepare(`SELECT project_key,${receiptTextColumns('project_key')} FROM mirror_projects WHERE discord_channel_id=?`);q.setReadBigInts(true);const keys=q.all(channel).map(row=>receiptText(row,'project_key')!);
 require(keys.every(stored=>matches(stored,key)),'created room already belongs to another project');
}
function beforeIn(db:DatabaseSync,key:string,channel:bigint,matches:MirrorProjectKeyMatch):MirrorContainerReceipt|null {
 const original=findIn(db,key,matches);if(original!==null){require(original.phase==='confirmed'&&original.channel===channel&&equal(snapshotIn(db,key,matches),expectedContainerMapping(original)),'project creation mapping is not confirmed');checkContainerCleanupIn(db,original);checkOtherMappings(db,key,channel,matches);}checkOtherClaims(db,key,channel,original!==null,matches);return original;
}
function finishIn(db:DatabaseSync,key:string,channel:bigint,original:MirrorContainerReceipt|null,matches:MirrorProjectKeyMatch):void {
 require(containerReceiptEqual(findIn(db,key,matches),original),'project creation custody changed during mapping');if(original===null){checkOtherClaims(db,key,channel,false,matches);return;}
 const final:MirrorProjectSnapshot=[[key,channel]];require(equal(snapshotIn(db,key,matches),final),'project mapping write was not exact');checkContainerCleanupIn(db,original);checkOtherMappings(db,key,channel,matches);
 const changed=db.prepare("DELETE FROM cdr_mirror_container_creations WHERE kind='project' AND scope_key=? AND token=? AND phase='confirmed' AND channel_id=?").run(original.key,original.token,channel).changes;
 require(BigInt(changed)===1n&&findIn(db,key,matches)===null&&equal(snapshotIn(db,key,matches),final),'project creation completion was not stored');checkContainerCleanupIn(db,original);checkOtherMappings(db,key,channel,matches);checkOtherClaims(db,key,channel,true,matches);
}
/** Alias rewrites, mapping and custody consumption are one IMMEDIATE transaction.
 * No remote creation/deletion happens here. Native-worker placement remains a
 * requirement of the future BridgeSync runtime caller. */
export async function upsertMirrorProject(path:string,key:string,name:string,channel:bigint,now:number,fn:MirrorProjectKeyMatch):Promise<readonly string[]> {
 requireDiscordText(path);requireDiscordText(key);requireDiscordText(name);containerI64(channel);if(typeof now!=='number')throw new TypeError('Expected f64 project timestamp');const matches=comparator(fn);
 return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  const original=beforeIn(db,key,channel,matches);const q=db.prepare(`SELECT project_key,${receiptTextColumns('project_key')} FROM mirror_projects`);q.setReadBigInts(true);const keys=q.all().map(row=>receiptText(row,'project_key')!);const aliases=keys.filter(stored=>stored!==key&&matches(stored,key));
  for(const alias of aliases){db.prepare('UPDATE mirror_threads SET project_key=? WHERE project_key=?').run(key,alias);db.prepare('DELETE FROM mirror_projects WHERE project_key=?').run(alias);}
  db.prepare('INSERT OR REPLACE INTO mirror_projects(project_key,project_name,discord_channel_id,updated_at) VALUES(?,?,?,?)').run(key,name,channel,now);finishIn(db,key,channel,original,matches);return commitStore(Object.freeze(aliases));
 }));
}
