import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {captureSqliteEvidenceRows} from './sqlite-evidence-rows.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {holdIn} from './execution-hold.ts';
import {holdIngressIn} from './ingress-recovery.ts';
import {unfinishedPriorIngressesIn} from './ingress-read.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {serdeValueEqual} from '../core/serde-value-equal.ts';
import {rustTrim} from '../config/remote.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
const VERSION='manual-reserve-v1',SENTINEL='manual-reserve-retirement-v1';
export interface ReserveRetirementLimits{readonly maxRows:number;readonly maxBytes:number;}
export interface ReserveRetirement{readonly alreadyCompleted:boolean;readonly heldJobs:bigint;readonly policySnapshots:bigint;}
const UNOWNED="SELECT * FROM discord_ingress_journal WHERE runtime_id IS NOT ? AND owner_id IS NULL AND state IN ('staged','acknowledged','executing','completed') AND confirmation_delivered=0 ORDER BY created_at,ingress_id";
function invalid(reason:string):never{throw new StoreIntegrityError('Reserve retirement: '+reason);}
function text(row:Record<string,unknown>,key:string):string{const value=row[key];return typeof value==='string'?value:invalid('missing '+key);}
/** Runtime startup's empty-headless-evidence branch. Caller owns an IMMEDIATE
 * transaction and exclusive startup/cutover guard; no dispatcher may run before
 * commit. No rows are deleted, no existing hold is cleared, and no model change
 * authorizes a request. On error caller must roll back this entire transaction.
 * Whole-operation row/byte budgets reject rather than partially retire. The
 * shared evidence decoder rejects malformed TEXT (stricter than Rust's lossy
 * audit conversion); that corrupt-data parity gap is explicit, not a fallback.
 * This synchronous leaf must run in the caller's native owner. */
export function retireAutomaticReserveAtStartupIn(db:DatabaseSync,limits:ReserveRetirementLimits):ReserveRetirement{
 const maxRows=own(limits,'maxRows'),maxBytes=own(limits,'maxBytes');
 if(typeof maxRows!=='number'||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>4096||typeof maxBytes!=='number'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4194304)throw new RangeError('Invalid retirement resource limits');
 if(!db.isTransaction)throw new StoreIntegrityError('Reserve retirement requires caller-owned transaction');
 if(db.prepare('SELECT 1 FROM cdr_store_retirements WHERE name=?').get(VERSION)!==undefined)return Object.freeze({alreadyCompleted:true,heldJobs:0n,policySnapshots:0n});
 const budget={bytes:0};let usedRows=0,jsonBytes=0;
 const rows=(sql:string,params:readonly SQLInputValue[]=[]):Record<string,unknown>[]=>{
  const columns=db.prepare(sql).columns();if(columns.length>128||columns.some(c=>Buffer.byteLength(c.name)>4096))invalid('column budget exceeded');
  const captured=captureSqliteEvidenceRows(db,sql,params,budget,{maxBytes,maxRows:Math.max(1,maxRows-usedRows),reject:reason=>invalid('evidence '+reason)}) as {columns:string[];rows:unknown[][]};
  usedRows+=captured.rows.length;if(usedRows>maxRows)invalid('complete row budget exceeded');
  if(captured.columns.length>128||captured.columns.some(c=>Buffer.byteLength(c)>4096))invalid('column budget exceeded');
  const result=captured.rows.map(cells=>{
   const row:Record<string,unknown>=Object.create(null) as Record<string,unknown>;
   for(let i=0;i<captured.columns.length;i++){
    const cell=cells[i] as unknown[];let value:unknown;
    if(cell[0]==='null')value=null;
    else if(cell[0]==='integer'||cell[0]==='text')value=cell[1];
    else if(cell[0]==='blob_hex')value={blob_hex:cell[1]};
    else if(cell[0]==='real_bits'){const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(BigInt(cell[1] as string));const number=bytes.readDoubleBE();value=Number.isFinite(number)?number:null;}
    else return invalid('unknown evidence cell');
    Object.defineProperty(row,captured.columns[i]!,{value,enumerable:true,writable:false,configurable:false});
   }
   jsonBytes+=Buffer.byteLength(serializeSerdeValue(row));if(jsonBytes>maxBytes)invalid('complete JSON evidence budget exceeded');return row;
  });return result;
 };
 let heldJobs=0n,policySnapshots=0n;
 for(const policy of rows('SELECT * FROM codex_reserve_policy ORDER BY thread_id')){
  const result=db.prepare('INSERT INTO cdr_reserve_retirement_evidence(thread_id,policy_json,retired_at) VALUES (?,?,unixepoch())').run(text(policy,'thread_id'),serializeSerdeValue(policy));policySnapshots+=BigInt(result.changes);
 }
 db.prepare("UPDATE codex_reserve_policy SET mode='manual' WHERE mode!='manual'").run();
 for(const [sql,intake] of [["SELECT * FROM codex_turn_queue WHERE state='pending' ORDER BY job_id",false],["SELECT * FROM codex_prompt_intakes ORDER BY job_id",true]] as const){
  for(const row of rows(sql)){
   const job=text(row,'job_id'),target=text(row,'target_thread_id');
   const ingress=rows("SELECT * FROM discord_ingress_journal WHERE owner_kind='prompt' AND owner_id=? AND kind IN ('message','interaction') ORDER BY created_at,ingress_id",[job]);
   const first=ingress[0];const confirmed=ingress.length===1&&first!==undefined&&first.confirmation_delivered===1n&&
    ['target_thread_id','channel_id','owner_user_id'].every(k=>serdeValueEqual(first[k],row[k]))&&(first.state==='owned'||first.state==='completed');
   let errorReported=false;
   for(const item of ingress){if(item.kind!=='message'||typeof item.event_id!=='bigint')continue;
    const key=serializeSerdeValue([item.channel_id,'message/error/v1',`inbound-message/${item.event_id}/error-report`,0n]);
    const q=db.prepare('SELECT EXISTS(SELECT 1 FROM codex_delivery_receipts WHERE receipt_key=? AND message_id IS NOT NULL) AS found');q.setReadBigInts(true);if(q.get(key)?.found===1n){errorReported=true;break;}
   }
   const failure=typeof row.last_error==='string'?row.last_error:'';
   if(rustTrim(failure)!==''||errorReported||!confirmed){holdIn(db,job,target,'Legacy request requires explicit recovery; changing the model will not execute it',serializeSerdeValue({row,ingress,intake}));heldJobs++;}
  }
 }
 // Admit the complete source-selected set under the same transaction before
 // the existing source decoder parses payload/outcome JSON or stages notices.
 const now=db.prepare('SELECT CAST(unixepoch() AS REAL) AS now').get()?.now;
 if(typeof now!=='number'||!Number.isFinite(now))invalid('invalid retirement timestamp');rows(UNOWNED,[SENTINEL]);
 for(const record of unfinishedPriorIngressesIn(db,SENTINEL))if(record.ownerId===null)holdIngressIn(db,record.ingressId,'legacy unowned request retained during manual Reserve retirement',record.state==='staged'||record.state==='acknowledged',now);
 const result=Object.freeze({alreadyCompleted:false,heldJobs,policySnapshots});
 db.prepare('INSERT INTO cdr_store_retirements(name,evidence_json,completed_at) VALUES (?,?,unixepoch())').run(VERSION,serializeSerdeValue({result:{already_completed:false,held_jobs:heldJobs,policy_snapshots:policySnapshots},headless:[]}));return result;
}
