import {parentPort,workerData} from 'node:worker_threads';import {DatabaseSync} from 'node:sqlite';
if(parentPort===null)throw new Error('Admin queue inspection requires owned native worker');
let db:DatabaseSync|undefined,phase='Open',result:unknown;
try{
 db=new DatabaseSync(workerData.path as string,{readOnly:true});phase='Timeout';db.exec('PRAGMA busy_timeout=3000');phase='Query';
 const statement=db.prepare("SELECT count(*) AS count FROM codex_turn_queue WHERE state IN ('running', 'starting')");statement.setReadBigInts(true);const count=statement.get()?.count;
 if(typeof count!=='bigint'||count<0n||count>9223372036854775807n)throw new TypeError('Invalid signed64 queue count');result={ok:true,count};
}catch(error){result={ok:false,phase,message:error instanceof Error?error.message.slice(0,4096):'Native queue inspection failed'};}
finally{try{db?.close();}catch(error){result={ok:false,phase:'Close',message:error instanceof Error?error.message.slice(0,4096):'Native queue close failed'};}parentPort.postMessage(result);parentPort.close();}
