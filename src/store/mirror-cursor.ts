import {usingInitializedStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {receiptRow,receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeI64,decodeTimestamp} from './sqlite-values.ts';
import {requireDiscordText} from '../discord/text.ts';
import type {DatabaseSync} from 'node:sqlite';
export interface MirrorOffset {readonly rolloutPath:string;readonly cursor:bigint;readonly updatedAt:number;}
const text=(...values:string[]):void=>{for(const value of values)requireDiscordText(value);};
const time=(value:number):void=>{if(typeof value!=='number')throw new TypeError('Expected numeric mirror timestamp');};
function offset(value:bigint):void{if(typeof value!=='bigint'||value<-(1n<<63n)||value>=(1n<<63n))throw new RangeError('Expected signed i64 mirror cursor');}
function replace(db:DatabaseSync,thread:string,rollout:string,cursor:bigint,now:number):void{
 db.prepare('INSERT OR REPLACE INTO codex_session_mirror_offsets(codex_thread_id,rollout_path,cursor,updated_at) VALUES(?,?,?,?)').run(thread,rollout,cursor,now);
}
/** Durable event claim only; caller must finish confirmed delivery first. */
export async function claimMirrorEvent(path:string,digest:string,thread:string,now:number):Promise<boolean>{
 text(path,digest,thread);time(now);return usingInitializedStore(path,db=>BigInt(db.prepare('INSERT OR IGNORE INTO codex_session_mirror_events(event_digest,codex_thread_id,created_at) VALUES(?,?,?)').run(digest,thread,now).changes)===1n);
}
export async function cleanupMirrorEvents(path:string,retentionSeconds:number,now:number):Promise<bigint>{
 text(path);time(retentionSeconds);time(now);const cutoff=now-retentionSeconds;return usingInitializedStore(path,db=>BigInt(db.prepare('DELETE FROM codex_session_mirror_events WHERE created_at < ?').run(cutoff).changes));
}
/** Source legacy path/cursor primitive. This is not a file-generation certificate,
 * complete-record boundary proof, or permission to advance after failed delivery. */
export async function getOrInitMirrorCursor(path:string,thread:string,rollout:string,initial:bigint,now:number):Promise<bigint>{
 text(path,thread,rollout);offset(initial);time(now);
 return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  const row=receiptRow(db,`SELECT rollout_path,cursor,${receiptTextColumns('rollout_path')} FROM codex_session_mirror_offsets WHERE codex_thread_id=?`,thread);
  if(row!==undefined){const oldPath=receiptText(row,'rollout_path')!,cursor=decodeI64(row.cursor,'cursor');if(oldPath===rollout)return commitStore(cursor);}
  replace(db,thread,rollout,initial,now);return commitStore(initial);
 }));
}
export async function getMirrorOffset(path:string,thread:string):Promise<MirrorOffset|null>{
 text(path,thread);return usingInitializedStore(path,db=>{
  const row=receiptRow(db,`SELECT rollout_path,cursor,updated_at,${receiptTextColumns('rollout_path')} FROM codex_session_mirror_offsets WHERE codex_thread_id=?`,thread);
  return row===undefined?null:Object.freeze({rolloutPath:receiptText(row,'rollout_path')!,cursor:decodeI64(row.cursor,'cursor'),updatedAt:decodeTimestamp(row.updated_at,'updated_at')});
 });
}
export async function updateMirrorCursor(path:string,thread:string,rollout:string,cursor:bigint,now:number):Promise<void>{
 text(path,thread,rollout);offset(cursor);time(now);return usingInitializedStore(path,db=>replace(db,thread,rollout,cursor,now));
}
/** null: absent/pre-upgrade cursor; empty string: initialized with no current turn. */
export async function getMirrorCursorTurn(path:string,thread:string):Promise<string|null>{
 text(path,thread);return usingInitializedStore(path,db=>{const row=receiptRow(db,`SELECT turn_context,${receiptTextColumns('turn_context')} FROM codex_session_mirror_offsets WHERE codex_thread_id=?`,thread);return row===undefined?null:receiptText(row,'turn_context',true);});
}
export async function updateMirrorCursorWithTurn(path:string,thread:string,rollout:string,cursor:bigint,now:number,turn:string|null):Promise<void>{
 text(path,thread,rollout);offset(cursor);time(now);if(turn!==null)text(turn);const retained=turn??'';
 return usingInitializedStore(path,db=>{db.prepare('INSERT OR REPLACE INTO codex_session_mirror_offsets(codex_thread_id,rollout_path,cursor,updated_at,turn_context) VALUES(?,?,?,?,?)').run(thread,rollout,cursor,now,retained);});
}
