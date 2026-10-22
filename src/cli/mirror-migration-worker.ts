import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {initializeMirrorCursorJournal} from '../store/mirror-cursor-journal.ts';
import {MigrationBudget} from './legacy-mirror-turn.ts';
import {migrateMirrorRow} from './mirror-migration-row.ts';
import {WindowsFilePin} from '../runtime/windows/windows-file-pin.ts';
import {legacyMirrorPolicy} from './legacy-mirror-policy.ts';
import {legacyMirrorRows,inspectLegacyMirrorRow,preserveLegacyMirrorRow,type LegacyMirrorInspection} from './legacy-mirror-inspection.ts';
import {initializeMirrorDeferrals} from '../store/mirror-deferral.ts';
import {deferLegacyMirrorRow} from './legacy-mirror-deferral.ts';
if(parentPort===null)throw new Error('Mirror cutover requires owned worker');
let db:DatabaseSync|undefined,state:DatabaseSync|undefined,pin:WindowsFilePin|undefined,result:unknown;
try{
 const policy=legacyMirrorPolicy(workerData.policy);
 pin=process.platform==='win32'?WindowsFilePin.acquire(workerData.path,'file'):undefined;
 db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=3000');initializeMirrorCursorJournal(db);
 if(policy==='rust-preserve'){state=new DatabaseSync(workerData.statePath,{readOnly:true});state.exec('PRAGMA busy_timeout=1000');initializeMirrorDeferrals(db);}
 const rows=legacyMirrorRows(db,workerData.thread);
 const migrated:string[]=[],already:string[]=[],held:{thread:string;reason:string}[]=[];
 const inactivePreserved:LegacyMirrorInspection[]=[],deferred:LegacyMirrorInspection[]=[];
 const budget=new MigrationBudget();
 for(const row of rows){const thread=row.codex_thread_id as string;
  try{
   if(state!==undefined){const inspected=inspectLegacyMirrorRow(db,state,row,policy,()=>budget.check());
    if(inspected.disposition==='Held')throw new Error(inspected.reason);
    if(inspected.disposition!=='Migrate'){
     if(inspected.requiresDurableHold)deferLegacyMirrorRow(db,state,row,inspected,()=>budget.check());
     else preserveLegacyMirrorRow(db,state,row,inspected,()=>budget.check());
     (inspected.disposition==='InactivePreserved'?inactivePreserved:deferred).push(inspected);continue;
    }
   }
   const status=await migrateMirrorRow(db,row,budget);(status==='already'?already:migrated).push(thread);
  }
  catch(e){held.push({thread,reason:e instanceof Error?e.message:'Cursor migration held'});}
 }
 result={ok:true,value:{policy,migrated,already,held,inactivePreserved,deferred,degraded:deferred.length>0,
  dormantHeldIngress:inactivePreserved.reduce((n,v)=>n+v.dormantHeld,0),cursorsPreserved:true,replayAuthorized:false,historicalDeliveryVerified:false}};
}catch(e){result={ok:false,error:e instanceof Error?e.message:'Mirror migration failed'};}
finally{try{if(db?.isTransaction)db.exec('ROLLBACK');state?.close();db?.close();pin?.close();}catch{result={ok:false,error:'Mirror migration cleanup unconfirmed'};}parentPort.postMessage(result);parentPort.close();}
