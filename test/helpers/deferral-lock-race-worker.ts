import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(workerData.path);
db.exec('PRAGMA busy_timeout=3000');
db.exec('BEGIN IMMEDIATE');db.exec(workerData.sql);parentPort!.postMessage('locked');
setTimeout(()=>{try{db.exec('COMMIT');}finally{db.close();parentPort!.close();}},200);
