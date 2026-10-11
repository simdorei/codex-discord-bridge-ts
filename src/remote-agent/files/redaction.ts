import {OwnedWorkerSlot} from '../../runtime/owned-worker-slot.ts';import {requireDiscordText} from '../../discord/text.ts';
const slot=new OwnedWorkerSlot();
/** One background CPU owner, no queue. Deadline/abort terminates this pure worker
 * and joins native exit before returning. Never substitutes unredacted text. */
export async function redactRemoteText(text:string,signal?:AbortSignal,timeoutMs=1000):Promise<string>{
 requireDiscordText(text);if(text.length>1048576||Buffer.byteLength(text)>1048576)throw new RangeError('Redaction input exceeds1MiB');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw new RangeError('Invalid redaction CPU deadline');
 const pending=slot.runCpu(new URL('./redaction-worker.ts',import.meta.url),text,timeoutMs,signal),joined=slot.join();let result:unknown;
 try{result=await pending;}finally{await joined;}signal?.throwIfAborted();
 if(result===null||typeof result!=='object'||!Object.hasOwn(result,'ok')||(result as {ok:unknown}).ok!==true||!Object.hasOwn(result,'text'))throw new Error('Remote redaction failed');
 const value=(result as {text:unknown}).text;requireDiscordText(value);if(value.length>2097152||Buffer.byteLength(value)>2097152)throw new RangeError('Redaction output exceeds2MiB');return value;
}
