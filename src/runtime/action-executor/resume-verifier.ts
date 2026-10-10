import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {readThreadWithTimeout,resumeThreadWithTimeout} from '../../app-server/requests.ts';
import {serdeField} from '../../app-server/value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {InvalidActionRequestError} from './errors.ts';
/** Source resume_action::recover/read_status only. Does not select a thread,
 * authorize an ingress or resend a prompt. Caller owns lifecycle target lock. */
export async function verifyResumedThread(server:PortableResidentLifecycle,thread:string,generation:bigint,timeoutMs:number,signal?:AbortSignal):Promise<'already loaded'|'recovered'>{
 requireDiscordText(thread);resumeThreadWithTimeout(thread,timeoutMs);if(typeof generation!=='bigint'||generation<0n||generation>=1n<<64n)throw new TypeError('Expected u64 generation');signal?.throwIfAborted();
 const deadline=performance.now()+timeoutMs,remaining=()=>{signal?.throwIfAborted();const ms=deadline-performance.now();if(ms<=0)throw new InvalidActionRequestError('resume check timed out');return Math.ceil(ms);};
 const read=async()=>{const response=await PortableResidentLifecycle.prototype.execute.call(server,readThreadWithTimeout(thread,false,Math.min(8000,remaining())),generation,signal);signal?.throwIfAborted();const value=serdeField(response,'thread');if(serdeField(value,'id')!==thread)throw new InvalidActionRequestError('thread/read returned a missing or different thread identity');
  switch(serdeField(serdeField(value,'status'),'type')){case 'idle':case 'active':return true;case 'notLoaded':return false;case 'systemError':throw new InvalidActionRequestError('thread reports systemError');default:throw new InvalidActionRequestError('thread runtime status is missing or unsupported');}
 };
 if(await read()&&!PortableResidentLifecycle.prototype.subscriptionResumeRequired.call(server,thread))return 'already loaded';
 const response=await PortableResidentLifecycle.prototype.execute.call(server,resumeThreadWithTimeout(thread,remaining()),generation,signal);signal?.throwIfAborted();if(serdeField(serdeField(response,'thread'),'id')!==thread)throw new InvalidActionRequestError('thread/resume returned a missing or different thread identity');
 if(!await read())throw new InvalidActionRequestError('thread is still not loaded after resume');return 'recovered';
}
