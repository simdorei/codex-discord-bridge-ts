import {usingExistingReadOnlyStore} from '../../store/owned-scope.ts';
import {mirrorDetailModeIn} from '../../store/mirror-policy-read.ts';
import {serveReusableWorker} from '../reusable-worker-entry.ts';
import type {ReusableNativeOperation} from '../reusable-worker-operations.ts';
import {decodeMirrorRecordWindow} from './record-window.ts';
import {collectSessionItems} from './collect.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
export const runNativeOperation:ReusableNativeOperation=(workerData,parentPort)=>{
try{
 const {bytes,startOffset,maxWindowBytes,maxRecordBytes,maxRecords,context}=workerData;
 const decoded=decodeMirrorRecordWindow(bytes,startOffset,maxWindowBytes,maxRecordBytes,maxRecords);
 if(context===undefined)parentPort.postMessage({ok:true,value:decoded});
 else{
  // Source empty-tail ordering: no detail DB read when no object events were
  // decoded. Parsing and the optional bounded SQL lookup stay in this one owner.
  const detail=typeof context.detail==='string'?context.detail:decoded.events.length===0?'Send':usingExistingReadOnlyStore(context.detail.databasePath,db=>mirrorDetailModeIn(db,context.thread));
  const collection=collectSessionItems(context.thread,decoded.events.map(event=>event.value),detail,context.currentTurn);
  const value={collection,eventCount:decoded.events.length,nextOffset:decoded.nextOffset,scannedRecords:decoded.scannedRecords,stop:decoded.stop};
  if(collection.items.length>16384||Buffer.byteLength(serializeSerdeValue(value))>8388608)throw new RangeError('Mirror display output exceeds bounded window budget; cursor retained');
  parentPort.postMessage({ok:true,value});
 }
}catch(error){parentPort.postMessage({ok:false,message:error instanceof Error?error.message:'Mirror decode failed'});}
finally{parentPort.close();}
};
await serveReusableWorker(runNativeOperation);
