import {OwnedPortableAppServerProcess,type PortableProcessConfig} from '../../app-server/portable-process.ts';
import type {NodeAppServerByteSource} from '../../app-server/node-streams.ts';
export class OwnedCommandLimitError extends Error{constructor(readonly kind:'Timeout'|'TooLarge'){super(`Owned command ${kind}`);this.name='OwnedCommandLimitError';}}
export class OwnedCommandCleanupError extends Error{constructor(readonly owner:OwnedPortableAppServerProcess,cause:unknown){super('Owned command cleanup is unconfirmed',{cause});this.name='OwnedCommandCleanupError';}}
export interface OwnedCommandResult{readonly stdout:Buffer;readonly stderr:Buffer;readonly exitCode:number|null;readonly processId:number;readonly timedOut:boolean;readonly cancelled:boolean;readonly truncated:boolean;readonly stdoutBytes:bigint;readonly stderrBytes:bigint;}
/** Fixed argv caller; no shell expansion. Cancellation settles only after the
 * original Job Object, descendants and both output pipes have actually joined. */
export async function runOwnedCommand(config:PortableProcessConfig,options:Readonly<{timeoutMs:number;maxBytes:number;signal?:AbortSignal|undefined;captureStop?:boolean;truncate?:boolean}>):Promise<OwnedCommandResult> {
  const {timeoutMs,maxBytes,signal}=options;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16777216)throw new RangeError('Invalid owned command budget');
  signal?.throwIfAborted();const abort=new AbortController();
  const cancel=()=>abort.abort(signal?.reason),timer=setTimeout(()=>abort.abort(new OwnedCommandLimitError('Timeout')),timeoutMs);
  signal?.addEventListener('abort',cancel,{once:true});let child:OwnedPortableAppServerProcess|undefined,streams:Promise<unknown>[]=[];
  try{
    child=await OwnedPortableAppServerProcess.spawn(config);abort.signal.throwIfAborted();
    const read=async(source:NodeAppServerByteSource)=>{const chunks:Buffer[]=[];let used=0,total=0n;for(;;){const bytes=await source.readChunk();if(bytes===null)break;total+=BigInt(bytes.length);if(total>BigInt(maxBytes)&&!options.truncate)throw new OwnedCommandLimitError('TooLarge');const take=Math.min(bytes.length,maxBytes-used);if(take>0){chunks.push(Buffer.from(bytes.subarray(0,take)));used+=take;}}return {bytes:Buffer.concat(chunks,used),total};};
    let rejectKill!:(error:unknown)=>void;const killFailed=new Promise<never>((_,reject)=>{rejectKill=reject;});void killFailed.catch(()=>{});
    const killed=()=>{try{child!.startKill();}catch(error){rejectKill(error);}};abort.signal.addEventListener('abort',killed,{once:true});
    try{await child.input.shutdown();const outPromise=read(child.stdout),errPromise=read(child.stderr);streams=[outPromise,errPromise];const [out,err]=await Promise.race([Promise.all([outPromise,errPromise,child.wait(options.captureStop?undefined:abort.signal)]),killFailed]);if(!options.captureStop)abort.signal.throwIfAborted();const timedOut=abort.signal.reason instanceof OwnedCommandLimitError;return Object.freeze({stdout:out.bytes,stderr:err.bytes,exitCode:abort.signal.aborted?null:child.exitCode,processId:child.processId,timedOut:abort.signal.aborted&&timedOut,cancelled:abort.signal.aborted&&!timedOut,truncated:out.total>BigInt(maxBytes)||err.total>BigInt(maxBytes),stdoutBytes:out.total,stderrBytes:err.total});}
    finally{abort.signal.removeEventListener('abort',killed);}
  }finally{
    clearTimeout(timer);signal?.removeEventListener('abort',cancel);
    if(child)try{await child.forceDispose();await Promise.allSettled(streams);}catch(error){throw new OwnedCommandCleanupError(child,error);}
  }
}
