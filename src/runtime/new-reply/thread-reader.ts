import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import type {ThreadInfo} from '../../codex-state/thread.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
const slot=new OwnedWorkerSlot();
function text(v:string,limit:number):void{requireDiscordText(v);if(v.includes('\0')||Buffer.byteLength(v)>limit)throw new RangeError('New reply thread lookup text budget exceeded');}
/** Read-only existing Codex DB, exact active thread, 256 KiB row. Parsing, native
 * SQLite and file probe run off-main. Slot remains occupied until actual exit;
 * cancellation never returns a late row. No file cursor or hold authority. */
export async function readNewReplyThreadOffThread(path:string,id:string,signal?:AbortSignal,timeoutMs=6000):Promise<ThreadInfo|null>{
 signal?.throwIfAborted();if(slot.busy)throw new OwnedWorkerBusyError();text(path,32768);text(id,16384);
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>10000)throw new RangeError('Invalid exact thread native timeout');
 const pinned=pinNativeRuntimePath(path);text(pinned,32768);const pending=slot.run(new URL('./thread-worker.ts',import.meta.url),{path:pinned,id},timeoutMs,signal),exited=slot.join();let raw:unknown;try{raw=await pending;}finally{await exited;}
 signal?.throwIfAborted();if(boundedSerdeByteCount(raw,1048576)===null)throw new RangeError('Exact native thread response exceeds budget');
 const response=cloneOwnedSerdeValue(raw);if(own(response,'ok')!==true){const detail=own(response,'detail');throw new Error(typeof detail==='string'?detail:'Exact thread read failed');}
 const value=own(response,'value');if(value===null)return null;
 if(own(value,'id')!==id)throw new Error('Native exact thread identity mismatch');
 for(const name of ['id','title','cwd','rolloutPath','model','reasoningEffort'])requireDiscordText(own(value,name));
 for(const name of ['updatedAt','archivedAt'])if(typeof own(value,name)!=='bigint')throw new TypeError('Invalid exact thread integer');
 const tokens=own(value,'tokensUsed');if(tokens!==null&&typeof tokens!=='bigint')throw new TypeError('Invalid exact thread token count');
 return value as ThreadInfo;
}
