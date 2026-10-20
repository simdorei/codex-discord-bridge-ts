import type {DatabaseSync} from 'node:sqlite';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {asI64,getOwn} from './async-resolution-json-helpers.ts';
import {selectJob,serializeStoredQueueJob,type StoredQueueJob} from './queue-read.ts';
import {parseStopControlJson,serializeStopControl,type StopControl} from './stop-control-dispatch.ts';
import {stopHoldSnapshotIn} from './stop-custody-common.ts';
import {decodeI64,decodeTextField,textDecoderFor} from './sqlite-values.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
export interface StopRecoveryCustody {readonly jobs:readonly StoredQueueJob[];readonly holds:readonly {readonly id:string;readonly snapshot:readonly [string,string,string]}[]}
/** Internal custody leaf only. Caller must validate original control, transaction,
 * binding, native observation lifetime and fences before mutation/commit. No writes. */
export function captureStopRecoveryCustodyIn(db:DatabaseSync,input:StopControl):StopRecoveryCustody{
 const control=parseStopControlJson(serializeStopControl(input));const ids=new Set<string>(),jobs:StoredQueueJob[]=[],holds:{id:string;snapshot:readonly [string,string,string]}[]=[];
 const refuse=():never=>{throw new StoreIntegrityError('original stop control authority differs; no interrupt or replay');};
 for(const raw of control.jobs){
  const original=parseSerdeValue(raw),id=getOwn(original,'job_id');if(typeof id!=='string'||ids.has(id))refuse();const key=id as string;ids.add(key);
  const snapshot=stopHoldSnapshotIn(db,key);if(snapshot===null||snapshot[0]!==control.target)refuse();holds.push({id:key,snapshot:snapshot!});
  const q=db.prepare('SELECT EXISTS(SELECT 1 FROM codex_turn_queue WHERE job_id=?) AS n');q.setReadBigInts(true);if(decodeI64(q.get(key)?.n,'exists')===0n)continue;
  const current=selectJob(db,key);if(current.state==='Pending'&&current.attemptCount===0n&&current.executionGeneration===null&&current.turnId===null){const generation=asI64(getOwn(original,'app_server_generation'));if(generation===undefined)refuse();current.appServerGeneration=generation!;}
  if(serializeStoredQueueJob(current)!==raw)refuse();jobs.push(current);
 }
 const active=db.prepare("SELECT job_id,CAST(job_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM codex_turn_queue WHERE target_thread_id=? AND state<>'pending'").all(control.target).map(row=>decodeTextField(row.job_id,row.raw,'job_id',false,textDecoderFor(row.encoding))!);
 if(active.some(id=>!ids.has(id)))refuse();return {jobs,holds};
}
