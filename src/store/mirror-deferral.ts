import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {withStoreTransaction,commitStore} from './owned-scope.ts';
import {StoreIntegrityError} from './schema-assembly.ts';

const TABLE='cdr_ts_mirror_deferrals_v1';
const DDL=`CREATE TABLE cdr_ts_mirror_deferrals_v1 (
 thread_id TEXT PRIMARY KEY NOT NULL, reason TEXT NOT NULL,
 operation_id TEXT UNIQUE NOT NULL, created_at REAL NOT NULL,
 evidence_json TEXT NOT NULL, evidence_sha256 TEXT NOT NULL,
 CHECK(length(CAST(thread_id AS BLOB)) BETWEEN 1 AND 16384),
 CHECK(reason IN ('CompressedSource','LegacyBindingConflict')),
 CHECK(length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 128),
 CHECK(created_at>=0), CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 1 AND 262144),
 CHECK(length(evidence_sha256)=64)
)`;
export type MirrorDeferralReason='CompressedSource'|'LegacyBindingConflict';
export interface MirrorDeferral {thread:string;reason:MirrorDeferralReason;operationId:string;createdAt:number;evidenceJson:string;evidenceSha256:string;}
export class MirrorDeferredError extends Error {
 constructor(){super('Mirror target is durably deferred; explicit reviewed reconciliation is required before history reads or delivery');this.name='MirrorDeferredError';}
}
function present(db:DatabaseSync):boolean{
 const row=db.prepare("SELECT type,CASE WHEN typeof(sql)='text' AND length(CAST(sql AS BLOB))<=4096 THEN sql END AS sql FROM sqlite_schema WHERE name=? COLLATE NOCASE").get(TABLE);
 if(row===undefined)return false;if(row.type!=='table'||row.sql!==DDL)throw new StoreIntegrityError('Mirror deferral schema is incompatible');return true;
}
function text(value:unknown,max:number):asserts value is string{
 if(typeof value!=='string'||value===''||value.includes('\0')||/[\uD800-\uDFFF]/u.test(value)||Buffer.byteLength(value)>max)throw new TypeError('Invalid bounded mirror deferral text');
}
function validate(value:MirrorDeferral):MirrorDeferral{
 text(value.thread,16384);text(value.operationId,128);text(value.evidenceJson,262144);
 if(!['CompressedSource','LegacyBindingConflict'].includes(value.reason)||typeof value.createdAt!=='number'||!Number.isFinite(value.createdAt)||value.createdAt<0||
  !/^[0-9a-f]{64}$/.test(value.evidenceSha256)||createHash('sha256').update(value.evidenceJson).digest('hex')!==value.evidenceSha256)throw new TypeError('Invalid mirror deferral evidence');
 const evidence=JSON.parse(value.evidenceJson);if(evidence?.version!==1||evidence.thread!==value.thread||evidence.policy!=='rust-preserve')throw new TypeError('Mirror deferral evidence identity differs');
 return Object.freeze({...value});
}
/** Explicit management initialization only; never called by runtime reads. */
export function initializeMirrorDeferrals(db:DatabaseSync):void{
 withStoreTransaction(db,'IMMEDIATE',()=>{if(!present(db))db.exec(DDL);return commitStore(undefined);});
}
/** Bounded indexed gate. Do not load audit packets or open history on a poll.
 * Any record blocks, including one whose audit data needs administrative repair. */
export function requireNoMirrorDeferralIn(db:DatabaseSync,thread:string):void{
 if(present(db)&&db.prepare(`SELECT 1 FROM ${TABLE} WHERE thread_id=? LIMIT 1`).get(thread)!==undefined)throw new MirrorDeferredError();
}
/** Management-only evidence read. A present malformed record is never absence. */
export function readMirrorDeferralIn(db:DatabaseSync,thread:string):MirrorDeferral|null{
 text(thread,16384);if(!present(db))return null;
 const row=db.prepare(`SELECT thread_id,reason,operation_id,created_at,
  CASE WHEN length(CAST(evidence_json AS BLOB))<=262144 THEN evidence_json END AS evidence_json,evidence_sha256
  FROM ${TABLE} WHERE thread_id=? LIMIT 1`).get(thread);
 if(row===undefined)return null;
 if(row.thread_id!==thread)throw new StoreIntegrityError('Mirror deferral target identity differs');
 return validate({thread,reason:row.reason as MirrorDeferralReason,operationId:row.operation_id as string,createdAt:row.created_at as number,evidenceJson:row.evidence_json as string,evidenceSha256:row.evidence_sha256 as string});
}
/** Caller owns the short transaction and eligibility CAS. Insert-only: there is
 * deliberately no release, overwrite, cursor mutation or rebinding API. */
export function insertMirrorDeferralIn(db:DatabaseSync,input:MirrorDeferral):void{
 if(!db.isTransaction||!present(db))throw new TypeError('Mirror deferral requires initialized caller transaction');
 const value=validate(input),old=readMirrorDeferralIn(db,value.thread);
 if(old!==null){if(JSON.stringify(old)!==JSON.stringify(value))throw new StoreIntegrityError('Existing mirror deferral evidence differs');return;}
 if(db.prepare(`INSERT INTO ${TABLE} VALUES(?,?,?,?,?,?)`).run(value.thread,value.reason,value.operationId,value.createdAt,value.evidenceJson,value.evidenceSha256).changes!==1)throw new StoreIntegrityError('Mirror deferral insert unconfirmed');
 const actual=readMirrorDeferralIn(db,value.thread);if(JSON.stringify(actual)!==JSON.stringify(value))throw new StoreIntegrityError('Mirror deferral postcondition differs');
}
