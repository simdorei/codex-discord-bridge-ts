import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {statSync} from 'node:fs';
import {authorizeSavedFinalIn} from '../store/final-recovery-claims.ts';
import {retireAutomaticReserveAtStartupIn} from '../store/reserve-retirement.ts';
import {inspectAsyncRecovery,inspectCompatibility,inspectFirstReply} from './admin-inspection.ts';
import {cancelForRecoveryExisting} from '../store/queue-cancel-recovery.ts';
import {cancelLatestPendingExisting} from '../store/queue-cancel-pending.ts';
import {CodexThreadStore} from '../codex-state/store.ts';
if(parentPort===null)throw new Error('Admin operation requires owned worker');
let db:DatabaseSync|undefined,result:unknown;
const d=workerData as {path:string;command:string;thread?:string;job?:string;request?:string;channel?:bigint;owner?:bigint;state?:string};
try{
 if(!statSync(d.path).isFile())throw new Error('Existing admin database is unavailable');
 let value:unknown;
 if(d.command==='cancel-tools')value=cancelForRecoveryExisting(d.path,d.thread!,d.channel!,d.owner!,Date.now()/1000,()=>undefined);
 else if(d.command==='cancel-writer'){
  db=new DatabaseSync(d.path,{readOnly:true});db.exec('PRAGMA busy_timeout=3000');const q=db.prepare("SELECT 1 FROM codex_turn_queue WHERE target_thread_id=? AND state!='quarantined' AND (state!='pending' OR channel_id!=? OR owner_user_id IS NOT ?) LIMIT 1");
  if(q.get(d.thread!,d.channel!,d.owner!))throw new Error('Running, uncertain or another sender request remains');db.close();db=undefined;
  const cancelled:string[]=[];for(let i=0;i<129;i++){const job=cancelLatestPendingExisting(d.path,d.thread!,d.channel!,d.owner!,Date.now()/1000);if(job===null)break;if(i===128)throw new Error('Writer cancellation exceeded bound');cancelled.push(job);}
  db=new DatabaseSync(d.path,{readOnly:true});if(db.prepare("SELECT 1 FROM codex_turn_queue WHERE target_thread_id=? AND state!='quarantined' UNION ALL SELECT 1 FROM codex_prompt_intakes WHERE target_thread_id=? LIMIT 1").get(d.thread!,d.thread!))throw new Error('Requests changed during recovery; Desktop not restarted');value=cancelled;
 }else if(d.command==='active-thread'){value=CodexThreadStore.open(d.state!).loadThreadBounded(d.thread!,false);if(value===null)throw new Error('Recovery target is not an existing active thread');}
 else if(d.command==='attachment-target'){db=new DatabaseSync(d.path,{readOnly:true});const q=db.prepare('SELECT discord_thread_id FROM mirror_threads WHERE codex_thread_id=? LIMIT 2');q.setReadBigInts(true);const r=q.all(d.thread!);if(r.length!==1||typeof r[0]!.discord_thread_id!=='bigint'||r[0]!.discord_thread_id<=0n)throw new Error('Thread has no unique Discord mapping');value=r[0]!.discord_thread_id;}
 else{
  const write=d.command==='retire-automatic-reserve'||d.command==='authorize-saved-final';db=new DatabaseSync(d.path,{readOnly:!write});db.exec('PRAGMA busy_timeout=3000');db.exec(write?'BEGIN IMMEDIATE':'PRAGMA query_only=ON; BEGIN');
  if(d.command==='retire-automatic-reserve')value=retireAutomaticReserveAtStartupIn(db,{maxRows:4096,maxBytes:4194304});
  else if(d.command==='authorize-saved-final')value=authorizeSavedFinalIn(db,d.request!);
  else if(d.command==='inspect-new-first-reply')value=inspectFirstReply(db,d.job!);
  else if(d.command==='inspect-async-recovery')value=inspectAsyncRecovery(db,d.thread!);
  else if(d.command==='check-recovery-compatibility')value=inspectCompatibility(db);
  else throw new Error('Unknown fixed admin database operation');
  db.exec(write?'COMMIT':'ROLLBACK');
 }
 result={ok:true,value};
}catch(e){result={ok:false,error:e instanceof Error?e.message:'Admin operation unconfirmed'};}
finally{try{if(db?.isTransaction)db.exec('ROLLBACK');db?.close();}catch{result={ok:false,error:'Admin database close failed'};}parentPort.postMessage(result);parentPort.close();}
