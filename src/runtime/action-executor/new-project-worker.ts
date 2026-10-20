import {parentPort,workerData as q} from 'node:worker_threads';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {decodeNewThreadOrigin,resolveNewProjectCwd} from './new-project-cwd.ts';
import {InvalidActionRequestError} from './errors.ts';
const port=parentPort;if(port===null)throw new Error('Project lookup requires owned worker');
try{const cwd=resolveNewProjectCwd(q.path,decodeNewThreadOrigin(parseSerdeValue(q.origin)),q.base),reply={ok:true,path:q.path,base:q.base,origin:q.origin,cwd};if(boundedSerdeByteCount(reply,16*1024*1024)===null)throw new RangeError('Project reply exceeds complete wire bound');port.postMessage(reply);}
catch(error){if(error instanceof InvalidActionRequestError&&Object.getPrototypeOf(error)===InvalidActionRequestError.prototype){const prefix='invalid command request: ',reply={ok:false,kind:'Invalid',path:q.path,base:q.base,origin:q.origin,reason:error.message.slice(prefix.length)};port.postMessage(boundedSerdeByteCount(reply,16*1024*1024)===null?{ok:false}:reply);}else port.postMessage({ok:false});}
finally{port.close();}
