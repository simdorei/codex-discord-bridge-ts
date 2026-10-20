import {parentPort,workerData as q} from 'node:worker_threads';
import {CodexThreadStore} from '../../codex-state/store.ts';
const port=parentPort;if(port===null)throw new Error('New reply thread read requires owned native worker');
try{const value=CodexThreadStore.open(q.path).loadThreadBounded(q.id,false,262144n);port.postMessage({ok:true,value});}
catch(error){let detail='',n=0;for(const ch of error instanceof Error?error.message:'Codex exact thread read failed'){if(n++===2048)break;detail+=ch;}port.postMessage({ok:false,detail});}
finally{port.close();}
