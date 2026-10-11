import {BridgeState} from '../runtime/bridge-state.ts';
import {parentPort,workerData as q} from 'node:worker_threads';
import {CodexThreadStore} from './store.ts';
import {resolveThreadRefPosix,ThreadResolveError} from './thread-reference.ts';
import {rustTrim} from '../app-server/value.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Thread reference requires native owner');
try{
 if(q.inventory!==true&&process.platform==='win32')throw new Error('Windows action reference resolution is not yet qualified');
 const store=CodexThreadStore.open(q.path);
 const inventory=()=>q.archived?store.loadArchivedThreadsBounded(4096n,4194304n):store.loadRecentThreadsBounded(4096n,4194304n);
 let value:unknown;
 if(q.inventory===true)value=inventory();
 else{const reference=rustTrim(q.reference),exact=store.loadThreadBounded(reference,q.archived,262144n);if(exact!==null)value=exact;else{const threads=inventory(),selected=typeof q.bridgePath==='string'?new BridgeState(q.bridgePath).selectedThreadIdBounded(1048576):q.selected;value=resolveThreadRefPosix(threads,reference,selected,q.archived);}}
 if(boundedSerdeByteCount(value,q.inventory===true?4194304:1048576)===null)throw new RangeError('Thread output exceeds byte budget');
 port.postMessage({ok:true,value});
}catch(error){
 if(error instanceof ThreadResolveError){const data={ok:false,resolve:{kind:error.kind,reference:error.reference,archived:error.archived,options:error.options}};if(boundedSerdeByteCount(data,1048576)!==null)port.postMessage(data);else port.postMessage({ok:false,detail:'Thread resolution error exceeds byte budget'});}
 else{let detail='',n=0;for(const c of error instanceof Error?error.message:'Thread reference failed'){if(n++===2048)break;detail+=c;}port.postMessage({ok:false,detail});}
}finally{port.close();}
