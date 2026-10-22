import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {legacyMirrorRows,inspectLegacyMirrorRow} from './legacy-mirror-inspection.ts';
import {legacyMirrorPolicy} from './legacy-mirror-policy.ts';
if(parentPort===null)throw new Error('Reconciliation requires owned worker');
let source:DatabaseSync|undefined,state:DatabaseSync|undefined,result:unknown;
const deadline=performance.now()+8000;
function check(){if(performance.now()>deadline)throw new Error('Reconciliation deadline exceeded');}
try{
 const policy=legacyMirrorPolicy(workerData.policy);
 source=new DatabaseSync(workerData.path,{readOnly:true});source.exec('PRAGMA busy_timeout=1000');
 state=new DatabaseSync(workerData.statePath,{readOnly:true});state.exec('PRAGMA busy_timeout=1000;BEGIN');
 const rows=legacyMirrorRows(source);
 const details=[];let bytes=0;
 for(const row of rows){check();const detail=inspectLegacyMirrorRow(source,state,row,policy,check);
  bytes+=Buffer.byteLength(JSON.stringify(detail));if(bytes>4194304)throw new Error('Reconciliation output budget exceeded');details.push(detail);
 }
 check();result={ok:true,value:{details,policy,stateRead:'Complete',advisory:true}};
}catch(e){result={ok:false,error:'Reconciliation unavailable: '+(e instanceof Error?e.message:'unknown failure')};}
finally{try{if(state?.isTransaction)state.exec('ROLLBACK');state?.close();source?.close();}catch{result={ok:false,error:'Reconciliation cleanup unconfirmed'};}parentPort.postMessage(result);parentPort.close();}
