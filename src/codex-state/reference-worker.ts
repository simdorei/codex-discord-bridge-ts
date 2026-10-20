import {BridgeState} from '../runtime/bridge-state.ts';
import {parentPort,workerData as q} from 'node:worker_threads';
import {CodexThreadStore} from './store.ts';
import {resolveThreadRef,ThreadResolveError} from './thread-reference.ts';
import {rustTrim} from '../app-server/value.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Thread reference requires native owner');
const reply=(value:object)=>port.postMessage(q.openSelected===true?{...value,binding:{mode:'BindingOpenSelected',path:q.path,bridgePath:q.bridgePath}}:q.contextRead!==undefined?{...value,binding:{mode:q.contextRead,path:q.path,limit:q.limit}}:q.archiveScope!==undefined?{...value,binding:{mode:'ArchiveScope',path:q.path,scope:q.archiveScope}}:q.exact===true?{...value,binding:{mode:'Exact',path:q.path,id:q.id,archived:q.archived}}:value);
try{

 const store=CodexThreadStore.open(q.path);
 const inventory=()=>q.archived?store.loadArchivedThreadsBounded(4096n,4194304n):store.loadRecentThreadsBounded(4096n,4194304n);
 let value:unknown;
 if(q.openSelected===true)value=new BridgeState(q.bridgePath).selectedThreadIdBounded(1048576);
 else if(q.contextRead==='ContextProbe')value=[];
 else if(q.contextRead==='ContextRecent')value=store.loadRecentThreadsLimitedBounded(q.limit);
 else if(q.archiveScope!==undefined){const missing:string[]=[];for(const id of q.archiveScope){const row=store.loadThreadBounded(id,true,262144n);if(row===null)missing.push(id);else if(row.id!==id)throw new TypeError('Archived row differs from requested identity');}value=missing;}
 else if(q.inventory===true)value=inventory();
 else if(q.exact===true)value=store.loadThreadBounded(q.id,q.archived,262144n);
 else{const reference=rustTrim(q.reference),exact=store.loadThreadBounded(reference,q.archived,262144n);if(exact!==null)value=exact;else{const threads=inventory(),selected=typeof q.bridgePath==='string'?new BridgeState(q.bridgePath).selectedThreadIdBounded(1048576):q.selected;value=resolveThreadRef(threads,reference,selected,q.archived);}}
 if(boundedSerdeByteCount(value,q.inventory===true||q.archiveScope!==undefined||q.contextRead!==undefined?4194304:1048576)===null)throw new RangeError('Thread output exceeds byte budget');
 reply({ok:true,value});
}catch(error){
 if(error instanceof ThreadResolveError){const data={ok:false,resolve:{kind:error.kind,reference:error.reference,archived:error.archived,options:error.options}};if(boundedSerdeByteCount(data,1048576)!==null)reply(data);else reply({ok:false,detail:'Thread resolution error exceeds byte budget'});}
 else{let detail='',n=0;for(const c of error instanceof Error?error.message:'Thread reference failed'){if(n++===2048)break;detail+=c;}reply({ok:false,detail});}
}finally{port.close();}
