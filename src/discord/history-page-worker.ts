import {parentPort,workerData} from 'node:worker_threads';
import {parseSerdeField} from '../core/serde-struct-json.ts';
import {modelVector} from './model/fields.ts';
import {discordMessageField} from './model/message.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
if(parentPort===null)throw new Error('History decoder requires owned parent');
try{
 if(!(workerData instanceof Uint8Array)||workerData.byteLength>2*1024*1024)throw new RangeError('History input budget');
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(workerData),value=parseSerdeField(text,modelVector(discordMessageField));
 if(!Array.isArray(value)||value.length>10||boundedSerdeByteCount(value,4*1024*1024)===null)throw new RangeError('History page count/transfer budget');
 parentPort.postMessage({ok:true,value});
}catch{parentPort.postMessage({ok:false});}
finally{parentPort.close();}
