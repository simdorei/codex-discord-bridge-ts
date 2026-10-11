import {parentPort,workerData} from 'node:worker_threads';
import {parseProjectOperation,projectRequestLifetimeSeconds} from './project-request.ts';
import {RemoteProtocolError} from './handshake.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
const port=parentPort;if(port===null)throw new Error('Remote decode requires a native owner');
try{
 const operation=parseProjectOperation(workerData.raw,workerData.maxBytes);
 const result={ok:true,operation,lifetimeSeconds:projectRequestLifetimeSeconds(operation)};
 // Added default/null fields consume a bounded allowance, not an unbounded output envelope.
 if(boundedSerdeByteCount(result,workerData.maxBytes+32768)===null)throw new RangeError('Native remote decode output exceeds budget');
 port.postMessage(result);
}catch(error){
 const kind=error instanceof RemoteProtocolError?error.kind:error instanceof RangeError?'Range':error instanceof TypeError?'Type':'Failure';
 let detail='',n=0;for(const char of error instanceof Error?error.message:'Remote decode failed'){if(n++===2048)break;detail+=char;}
 port.postMessage({ok:false,kind,detail});
}finally{port.close();}
