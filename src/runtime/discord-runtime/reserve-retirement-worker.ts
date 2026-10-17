import {parentPort,workerData as q} from 'node:worker_threads';
import type {DatabaseSync} from 'node:sqlite';
import {openInitialized} from '../../store/owned-driver.ts';
import {retireAutomaticReserveAtStartupIn} from '../../store/reserve-retirement.ts';
const port=parentPort;if(port===null)throw new Error('Reserve retirement requires owned native worker');
let db:DatabaseSync|undefined,commitAttempted=false,response:unknown;
try{
 db=await openInitialized(q.path);db.exec('BEGIN IMMEDIATE');
 const result=retireAutomaticReserveAtStartupIn(db,q.limits);
 if(result.alreadyCompleted)db.exec('ROLLBACK');else{commitAttempted=true;db.exec('COMMIT');}
 response={ok:true,result};
}catch(error){
 let uncertain=commitAttempted;
 if(db!==undefined)try{if(db.isTransaction)db.exec('ROLLBACK');}catch{uncertain=true;}
 response={ok:false,uncertain,detail:[...(error instanceof Error?error.message:'Reserve retirement failed')].slice(0,2048).join('')};
}finally{
 if(db!==undefined)try{db.close();}catch{response={ok:false,uncertain:true,detail:'Native store close failed'};}
 port.postMessage(response);port.close();
}
