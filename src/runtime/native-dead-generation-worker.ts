import {createHash} from 'node:crypto';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {parentPort,workerData as q} from 'node:worker_threads';
import {I64_MAX} from '../protocol/ids.ts';
import {decodeDeadGenerationTransfer} from '../app-server/dead-generation-transfer.ts';
import {serializeDeadGenerationWork} from '../app-server/dead-generation-work.ts';
import {extractThreadId} from '../app-server/identity.ts';
import {StateAccessFacade as state} from '../store/state-access-facade.ts';
import {passiveErrorText} from '../core/passive-error-text.ts';
const port=parentPort;if(port===null)throw new Error('Dead-generation capture requires an owned native worker');
const bounded=(value:string)=>{let out='',count=0;for(const ch of value){if(count++===2048)break;out+=ch;}return out;};
let binding:string|null=null;
try{
 if(boundedSerdeByteCount(q,1114112)===null)throw new RangeError('Dead-generation request exceeds native boundary');
 binding=createHash('sha256').update(serializeSerdeValue(q)).digest('hex');
 const work=decodeDeadGenerationTransfer(q.work);if(work.generation!==q.generation||work.generation<=0n||work.generation>I64_MAX)throw new RangeError('Invalid signed dead generation');
 const scoped=work.serverRequests.map(r=>extractThreadId(r.params)),targets=[...work.activeTurns.map(t=>t.threadId),...scoped.filter((t):t is string=>t!==null)];
 // The only operation is this existing-only capture transaction. No activation,
 // schema initialization, arbitrary operation/SQL, replacement or request replay.
 const captured=state.captureDeadGenerationExisting(q.path,{runtimeId:q.runtime,generation:work.generation,snapshotJson:serializeDeadGenerationWork(work),affectedTargets:targets,startupChannelId:q.startupChannel,hasUnscopedRequests:scoped.some(t=>t===null),now:Date.now()/1000});
 port.postMessage({ok:true,operation:q.operation,generation:work.generation,binding,captured});
}catch(error){port.postMessage({ok:false,operation:q.operation,generation:q.generation,binding,detail:bounded(passiveErrorText(error,'Native dead-generation capture failed'))});}
finally{port.close();}
