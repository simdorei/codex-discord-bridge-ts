import type {DatabaseSync} from 'node:sqlite';
import {withStoreTransaction,commitStore} from './owned-scope.ts';
import {receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
export const MIRROR_STARTUP_INTENT_TABLE='cdr_ts_mirror_startup_intents_v1';
const DDL=`CREATE TABLE cdr_ts_mirror_startup_intents_v1 (
 thread_id TEXT PRIMARY KEY NOT NULL, cutoff_json TEXT NOT NULL,
 operation_id TEXT UNIQUE NOT NULL, created_at REAL NOT NULL,
 CHECK(length(CAST(thread_id AS BLOB)) BETWEEN 1 AND 32768),
 CHECK(length(CAST(cutoff_json AS BLOB))<=524288),
 CHECK(length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 256)
)`;
export class MirrorStartupIntentSchemaError extends StoreIntegrityError {
 constructor(){super('Mirror startup intent schema is missing or incompatible; explicit initialization is required');this.name='MirrorStartupIntentSchemaError';}
}
export class MirrorStartupIntentConflictError extends Error {
 constructor(){super('Mirror startup intent conflicts with the exact pending operation or an existing cursor');this.name='MirrorStartupIntentConflictError';}
}
function present(db:DatabaseSync):boolean {
 const row=db.prepare(`SELECT type,sql,${receiptTextColumns('sql')} FROM (SELECT type,CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=4096 THEN sql END AS sql FROM sqlite_schema WHERE name=? COLLATE NOCASE)`).get(MIRROR_STARTUP_INTENT_TABLE);
 if(row===undefined)return false;
 if(row.type!=='table'||receiptText(row,'sql')!==DDL)throw new MirrorStartupIntentSchemaError();return true;
}
export function requireMirrorStartupIntentJournalIn(db:DatabaseSync):void {if(!present(db))throw new MirrorStartupIntentSchemaError();}
/** Separate, explicit opt-in. Never runs from schema assembly, reads or writes. */
export function initializeMirrorStartupIntentJournal(db:DatabaseSync):void {
 withStoreTransaction(db,'IMMEDIATE',()=>{if(!present(db))db.exec(DDL);requireMirrorStartupIntentJournalIn(db);return commitStore(undefined);});
}
/** Existing cursor paths remain compatible when this optional journal is absent.
 * Once opted in, any pending row is a hold, never fresh/reset/adoption authority. */
export function requireNoPendingMirrorStartupIntentIn(db:DatabaseSync,thread:string):void {
 if(present(db)&&db.prepare(`SELECT 1 FROM ${MIRROR_STARTUP_INTENT_TABLE} WHERE thread_id=? LIMIT 1`).get(thread)!==undefined)throw new MirrorStartupIntentConflictError();
}
