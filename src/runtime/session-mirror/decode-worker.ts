import {parentPort,workerData} from 'node:worker_threads';
import {decodeMirrorRecordWindow} from './record-window.ts';
import {collectSessionItems} from './collect.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
if(parentPort===null)throw new Error('Mirror decode worker requires an owned parent');
try{
 const {bytes,startOffset,maxWindowBytes,maxRecordBytes,maxRecords,context}=workerData;
 const decoded=decodeMirrorRecordWindow(bytes,startOffset,maxWindowBytes,maxRecordBytes,maxRecords);
 if(context===undefined)parentPort.postMessage({ok:true,value:decoded});
 else{
  const collection=collectSessionItems(context.thread,decoded.events.map(event=>event.value),context.detail,context.currentTurn);
  const value={collection,nextOffset:decoded.nextOffset,scannedRecords:decoded.scannedRecords,stop:decoded.stop};
  if(collection.items.length>16384||Buffer.byteLength(serializeSerdeValue(value))>8388608)throw new RangeError('Mirror display output exceeds bounded window budget; cursor retained');
  parentPort.postMessage({ok:true,value});
 }
}catch(error){parentPort.postMessage({ok:false,message:error instanceof Error?error.message:'Mirror decode failed'});}
finally{parentPort.close();}
