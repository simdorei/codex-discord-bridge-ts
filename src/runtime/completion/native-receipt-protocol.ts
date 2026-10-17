import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {parseReceiptKey} from '../../store/delivery-receipt-key.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
export const NATIVE_RECEIPT_BYTES=16*1024*1024;
/** Exact request echo, including original guard and per-operation nonce. */
export function receiptBinding(input:unknown):string{
 if(boundedSerdeByteCount(input,NATIVE_RECEIPT_BYTES)===null)throw new RangeError('Receipt request exceeds native boundary');
 const operation=own(input,'operation'),keys=['requestId','path','key','hash','guard','operation',...(operation==='Confirm'?['message']:operation==='Block'?['reason']:[])];
 if(input===null||typeof input!=='object'||Reflect.ownKeys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key)))throw new TypeError('Invalid exact receipt request');
 if(!['Begin','Confirm','Release','Block'].includes(operation as string))throw new TypeError('Invalid receipt operation');
 for(const key of keys.filter(key=>key!=='guard'))requireDiscordText(own(input,key));
 const id=own(input,'requestId') as string,path=own(input,'path') as string,key=own(input,'key') as string,hash=own(input,'hash') as string;
 if(!/^[0-9a-f-]{36}$/.test(id)||Buffer.byteLength(path)>32768||path.includes('\0')||Buffer.byteLength(key)>65536||parseReceiptKey(key)===null||!/^[0-9a-f]{64}$/.test(hash))throw new TypeError('Invalid receipt identity');
 const guard=own(input,'guard');if(guard!==null){const fields=['jobId','threadId','turnId'];if(typeof guard!=='object'||Reflect.ownKeys(guard).length!==3)throw new TypeError('Invalid receipt guard');for(const field of fields){const value=own(guard,field);requireDiscordText(value);if(Buffer.byteLength(value)>16384)throw new TypeError('Invalid receipt guard');}}
 if(operation==='Confirm'){const message=own(input,'message') as string;if(!/^[1-9][0-9]{0,19}$/.test(message)||BigInt(message)>=1n<<64n)throw new TypeError('Invalid receipt message');}
 return serializeSerdeValue(input);
}
