import {parentPort,workerData as q} from 'node:worker_threads';
import {StateAccessFacade} from '../store/state-access-facade.ts';
const port=parentPort;if(port===null)throw new Error('Native response completion requires owned worker');
try{
 // Closed completion operation only. Reuse original identity/retained-row checks
 // and IMMEDIATE transaction; no new authority capture or arbitrary SQL.
 if(typeof q.requestId!=='string'||q.requestId.length!==36)throw new TypeError('Expected original completion identity');
 StateAccessFacade.finishResponseCustody(q.path,q.scope,q.authority,q.payload,q.outcome);
 port.postMessage({ok:true,requestId:q.requestId});
}catch{port.postMessage({ok:false,requestId:q.requestId});}
finally{port.close();}
