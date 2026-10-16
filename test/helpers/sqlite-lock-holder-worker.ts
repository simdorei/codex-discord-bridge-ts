import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
const port=parentPort;
if(port===null)throw new Error('Owned lock worker requires parent');
const q=workerData as {path:string;anchor:SharedArrayBuffer;releaseMs:number;guardMs:number};
const anchor=new BigInt64Array(q.anchor),clock=()=>process.hrtime.bigint();
const db=new DatabaseSync(q.path,{timeout:5000,enableForeignKeyConstraints:false});
let done=false;
function finish(reason:string){if(done)return;done=true;clearInterval(check);clearTimeout(guard);const began=clock();try{if(db.isTransaction)db.exec('ROLLBACK');port!.postMessage({kind:'released',reason,began:String(began),at:String(clock())});}finally{db.close();port!.close();}}
const check=setInterval(()=>{const start=Atomics.load(anchor,0);if(start>0n&&clock()>=start+BigInt(q.releaseMs)*1_000_000n)finish('anchored-release');},1);
const guard=setTimeout(()=>finish('safety-guard'),q.guardMs);
port.on('message',message=>{if(message?.kind==='cleanup')finish('cleanup');});
try{const before=clock();db.exec('BEGIN IMMEDIATE');port.postMessage({kind:'locked',before:String(before),at:String(clock())});}
catch(error){finish('failed');throw error;}
