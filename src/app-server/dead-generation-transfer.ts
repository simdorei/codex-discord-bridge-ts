import {types} from 'node:util';
import {ServerRequestOccurrence} from '../protocol/ids.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {cloneDeadGenerationWork,type DeadGenerationWork} from './dead-generation-work.ts';
export const DEAD_GENERATION_TRANSFER_LIMIT=1048576;
function fields(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(value===null||typeof value!=='object'||types.isProxy(value)||Array.isArray(value))throw new TypeError('Expected passive dead-generation transfer');
 const names=Reflect.ownKeys(value);if(names.length!==keys.length||names.some(k=>typeof k!=='string'||!keys.includes(k)))throw new TypeError('Unexpected dead-generation transfer fields');
 const out:Record<string,unknown>=Object.create(null);for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Expected own dead-generation transfer fields');out[key]=d.value;}return out;
}
function vector(value:unknown):unknown[]{
 if(!Array.isArray(value)||types.isProxy(value)||value.length>65536||Reflect.ownKeys(value).length!==value.length+1)throw new TypeError('Expected bounded dense dead-generation vector');
 const result=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Expected own dead-generation vector');result.push(d.value);}return result;
}
/** Occurrences have private branded bytes: structured clone alone would lose them.
 * Refuse oversize input before a deep copy or serialized snapshot is allocated. */
export function encodeDeadGenerationTransfer(input:DeadGenerationWork):unknown {
 const w=fields(input,['generation','closedReason','activeTurns','serverRequests']);
 const activeTurns=vector(w.activeTurns).map(t=>fields(t,['threadId','turnId']));
 const serverRequests=vector(w.serverRequests).map(q=>{const r=fields(q,['id','occurrence','method','params']);return {...r,occurrence:Array.from(ServerRequestOccurrence.prototype.asBytes.call(r.occurrence))};});
 const wire={generation:w.generation,closedReason:w.closedReason,activeTurns,serverRequests};
 if(boundedSerdeByteCount(wire,DEAD_GENERATION_TRANSFER_LIMIT)===null)throw new RangeError('Dead-generation work exceeds native transfer budget');
 return cloneOwnedSerdeValue(wire);
}
export function decodeDeadGenerationTransfer(input:unknown):DeadGenerationWork {
 if(boundedSerdeByteCount(input,DEAD_GENERATION_TRANSFER_LIMIT)===null)throw new RangeError('Invalid dead-generation native transfer');
 const w=fields(input,['generation','closedReason','activeTurns','serverRequests']);
 const serverRequests=vector(w.serverRequests).map(q=>{const r=fields(q,['id','occurrence','method','params']),bytes=vector(r.occurrence);if(bytes.length!==16||bytes.some(b=>typeof b!=='number'||!Number.isInteger(b)||b<0||b>255))throw new TypeError('Invalid dead-generation occurrence bytes');return {...r,occurrence:ServerRequestOccurrence.fromBytes(Uint8Array.from(bytes as number[]))};});
 return cloneDeadGenerationWork({...w,serverRequests});
}
