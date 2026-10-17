import {parentPort,workerData} from 'node:worker_threads';
const {id, shared, offered}=workerData as {id:string;shared:SharedArrayBuffer;offered:string};
const state=new Int32Array(shared);
Atomics.store(state,1,1);
while(Atomics.load(state,0)===0)Atomics.wait(state,0,0);
Atomics.store(state,2,1);
parentPort!.postMessage({id,offeredBytes:Buffer.byteLength(offered)});
while(Atomics.load(state,3)===0)Atomics.wait(state,3,0);
parentPort!.close();
