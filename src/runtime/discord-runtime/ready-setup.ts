import {randomUUID} from 'node:crypto';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {nativeGatewayShutdownClock,type GatewayShutdownClock} from '../../discord/gateway/shutdown.ts';
import type {GatewayIdentity,GatewayIdentityConflict,GatewayStateReceiver} from '../../discord/gateway/identity.ts';
import {waitForGatewayIdentity} from './identity-wait.ts';
import {guardGatewayIdentity} from './identity-guard.ts';
import {StartupNoticeState,STARTUP_NOTICE_DOMAIN} from './startup-notice.ts';
export type ReadyCommandScope={readonly kind:'Global'}|{readonly kind:'Guild';readonly guildId:bigint};
/** Explicit effect boundary. Implementations must settle only after their native
 * request and cleanup settle, honoring signal. Command schema/HTTP registration
 * adapter is a separate unit; this interface does not claim those are wired. */
export interface ReadySetupPort{
 register(applicationId:bigint,scope:ReadyCommandScope,qa:boolean,signal:AbortSignal):Promise<void>;
 sendNotice(channelId:bigint,content:string,domain:string,key:string,chunk:0,signal:AbortSignal):Promise<void>;
}
export interface ReadySetupOptions{readonly port:ReadySetupPort;readonly guildId:bigint|null;readonly qaCommands:boolean;readonly startupNotify:boolean;readonly startupChannelId:bigint|null;readonly report:(kind:'ready'|'registration'|'notice',value:unknown,delayMs?:number)=>void;readonly clock?:GatewayShutdownClock;readonly bootKey?:()=>string}
const delays=Object.freeze([1000,2000,4000,8000,16000,30000]);
export function readyRetryDelay(failures:number):number{if(!Number.isSafeInteger(failures)||failures<0)throw new TypeError('Expected nonnegative retry index');return delays[Math.min(failures,5)]!;}
function id(value:bigint|null):void{if(value!==null&&(typeof value!=='bigint'||value<=0n||value>(1n<<64n)-1n))throw new TypeError('Expected optional nonzero Discord ID');}
/** One identity-guarded Ready lifecycle. Registration and startup notice retry
 * independently at 1/2/4/8/16/30s; successful setup stays under conflict watch.
 * Uses injected owned effect port, never an implicit network fallback. */
export async function runReadySetup(identity:GatewayStateReceiver<GatewayIdentity|null>,conflict:GatewayStateReceiver<GatewayIdentityConflict|null>,shutdown:AbortSignal,force:AbortSignal,options:ReadySetupOptions):Promise<void>{
 const {guildId,qaCommands,startupNotify,startupChannelId}=options;id(guildId);id(startupChannelId);if(typeof qaCommands!=='boolean'||typeof startupNotify!=='boolean')throw new TypeError('Expected Ready flags');
 const register=options.port.register.bind(options.port),sendNotice=options.port.sendNotice.bind(options.port),report=options.report.bind(options),clock=options.clock??nativeGatewayShutdownClock,bootKey=options.bootKey??(()=>randomUUID().replaceAll('-',''));
 const value=await waitForGatewayIdentity(identity,conflict,shutdown,force);if(value===null)return;invokeSynchronousVoid(report,{},['ready',value]);
 const scope:ReadyCommandScope=Object.freeze(guildId===null?{kind:'Global'}:{kind:'Guild',guildId});
 const setup=await guardGatewayIdentity(async signal=>{
  const siblings=new AbortController(),workSignal=AbortSignal.any([signal,siblings.signal]);
  const retry=async(kind:'registration'|'notice',operation:()=>Promise<void>)=>{let failures=0;for(;;){workSignal.throwIfAborted();try{await operation();return;}catch(error){workSignal.throwIfAborted();const delay=readyRetryDelay(failures);failures=Math.min(failures+1,5);invokeSynchronousVoid(report,{},[kind,error,delay]);const now=clock.now();if(!Number.isFinite(now)||now<0)throw new TypeError('Expected monotonic Ready clock');await clock.sleepUntil(now+delay,workSignal);}}};
  const registration=Promise.resolve().then(()=>retry('registration',()=>register(value.applicationId,scope,qaCommands,workSignal)));
  const notice=Promise.resolve().then(async()=>{if(!startupNotify||startupChannelId===null)return;const state=new StartupNoticeState(bootKey());await retry('notice',async()=>{await state.trySend(()=>sendNotice(startupChannelId,'Codex Discord Rust runtime started.',STARTUP_NOTICE_DOMAIN,state.logicalKey,0,workSignal));});});
  // Tokio join! owns both child futures. In Node, a sibling failure explicitly
  // cancels the other and allSettled joins both before escaping this operation.
  const owned=[registration,notice].map(work=>work.catch(error=>{siblings.abort(error);throw error;}));const results=await Promise.allSettled(owned);if(results.some(result=>result.status==='rejected'))throw siblings.signal.reason;
 },conflict,shutdown,force);
 if(!setup.completed)return;
 await guardGatewayIdentity(signal=>new Promise<void>((_resolve,reject)=>{signal.throwIfAborted();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}),conflict,shutdown,force);
}
