import type {DatabaseSync} from 'node:sqlite';
import {REVIEWED_INCIDENT_THREAD as THREAD} from './async-resolution-policy.ts';
import {AsyncResolutionHeldError} from './async-resolution-admission.ts';
import {receiptRow,receiptText,receiptTextColumns,receiptExists} from './delivery-receipt-key.ts';
import {decodeI64} from './sqlite-values.ts';
import {usingInitializedStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {requireDiscordText} from '../discord/text.ts';
const KEYS=['policy','proposal_sha256','original_turn_id','origin_job_id','pending_job_id'] as const;
const EXPECTED=['publishing_recovery','b1ffb41351d1086c0d807cd900c0fc651ec3577a9455af18dc6d11ec77218c95','01a0d9f0-8cb2-7e71-a0c1-2644d8ae45db','0cd97817-5f74-4e39-a74d-68ed9259c5a5','b3d5a1a3-5c3e-4764-967b-0cef767efde9'] as const;
function registration(db:DatabaseSync):readonly [bigint,...string[]]|null{
 const row=receiptRow(db,`SELECT format_version,${KEYS.join(',')},${receiptTextColumns(...KEYS)} FROM cdr_async_recovery_policies WHERE thread_id=?`,THREAD);
 if(row===undefined)return null;
 return [decodeI64(row.format_version,'format_version'),...KEYS.map(key=>receiptText(row,key)!)];
}
function matches(row:readonly [bigint,...string[]]):boolean{return row[0]===1n&&EXPECTED.every((v,i)=>row[i+1]===v);}
export function reviewedRecoveryPolicyInstalledIn(db:DatabaseSync):boolean{
 if(!receiptExists(db,"SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?) AS held",'cdr_async_recovery_policies'))return false;
 const row=registration(db);return row!==null&&matches(row);
}
/** Owns one IMMEDIATE transaction on the borrowed connection. Exact incident hold
 * only: never approves publishing, replays a pending job or clears other targets. */
export function installReviewedRecoveryPolicyOn(db:DatabaseSync):void{
 withStoreTransaction(db,'IMMEDIATE',()=>{
  const fail=(reason:string):never=>{throw new AsyncResolutionHeldError(THREAD,reason);};
  const version=decodeI64(receiptRow(db,'SELECT format_version FROM cdr_runtime_capability_requirements WHERE component=?','async_recovery_policy')?.format_version,'format_version');
  if(version!==1n)fail('unsupported persisted recovery-policy capability');
  const existing=registration(db);
  if(existing!==null){if(!matches(existing))fail('reviewed incident policy identity changed; existing evidence preserved');}
  else db.prepare("INSERT INTO cdr_async_recovery_policies (thread_id,format_version,policy,proposal_sha256,original_turn_id,origin_job_id,pending_job_id) VALUES(?,?,'publishing_recovery',?,?,?,?)").run(THREAD,1n,...EXPECTED.slice(1));
  if(receiptExists(db,"SELECT EXISTS(SELECT 1 FROM cdr_async_execution_obligations WHERE thread_id=? AND (format_version!=? OR policy NOT IN ('ordinary','publishing_recovery'))) AS held",THREAD,1n))fail('unsupported original obligation policy; no evidence rewritten');
  db.prepare("UPDATE cdr_async_execution_obligations SET policy='publishing_recovery',admission_state='held' WHERE thread_id=? AND policy='ordinary'").run(THREAD);
  if(receiptExists(db,"SELECT EXISTS(SELECT 1 FROM cdr_async_execution_obligations WHERE thread_id=? AND (policy!='publishing_recovery' OR admission_state!='held')) AS held",THREAD)||!reviewedRecoveryPolicyInstalledIn(db))fail('reviewed incident hold did not commit exactly');
  return commitStore(undefined);
 });
}
/** Existing initialized-store boundary; synchronous SQLite body is not offload. */
export async function installReviewedRecoveryPolicy(path:string):Promise<void>{
 requireDiscordText(path);await usingInitializedStore(path,installReviewedRecoveryPolicyOn);
}
