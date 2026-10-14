import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {MirrorStartupCutoff} from './startup-context-reader.ts';
import {prepareMirrorStartupIntent,snapshotPendingMirrorStartupIntent,type PendingMirrorStartupIntent} from '../../store/mirror-startup-intent.ts';
type Request={readonly kind:'Read';readonly thread:string}|{readonly kind:'Schema'}|{readonly kind:'Retain';readonly intent:PendingMirrorStartupIntent};
export class MirrorStartupIntentStoreReadError extends Error {constructor(detail:string){super('Mirror startup intent read held: '+detail);this.name='MirrorStartupIntentStoreReadError';}}
export class MirrorStartupIntentWriteUnconfirmedError extends Error {
 readonly operation:'Schema'|'Retain';readonly operationId:string|null;readonly thread:string|null;
 constructor(request:Exclude<Request,{kind:'Read'}>,cause:unknown){super('Mirror startup intent write is unconfirmed; retain the exact operation and reconcile after native exit',{cause});this.name='MirrorStartupIntentWriteUnconfirmedError';this.operation=request.kind;this.operationId=request.kind==='Retain'?request.intent.operationId:null;this.thread=request.kind==='Retain'?request.intent.thread:null;}
}
function text(value:string,max:number,nonempty=false):void {requireDiscordText(value);if(value.length>max||Buffer.byteLength(value)>max||(nonempty&&value===''))throw new RangeError('Mirror startup intent text budget exceeded');}
/** Explicit storage adapter only. A read has no file IO, EOF recapture or schema
 * repair. Retain accepts authentic captured EOF, including a held boundary.
 * No pending-to-bound transition or automatic runtime invocation is exposed. */
export class NativeMirrorStartupIntentStore {
 readonly #path:string;readonly #timeout:number;readonly #slot=new OwnedWorkerSlot();
 #closed=false;#controller:AbortController|null=null;#inflight:Promise<unknown>|null=null;
 constructor(path:string,timeoutMs=5000){
  text(path,32768);if(path.includes('\0'))throw new TypeError('NUL mirror startup store path');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid mirror startup store deadline');
  const pinned=pinNativeRuntimePath(path);text(pinned,32768);this.#path=pinned;this.#timeout=timeoutMs;
 }
 get busy():boolean{return this.#inflight!==null;}
 async close(reason:unknown=new Error('Mirror startup intent store closed')):Promise<void>{this.#closed=true;this.#controller?.abort(reason);if(this.#inflight!==null)await Promise.allSettled([this.#inflight]);}
 async initializeSchema(signal?:AbortSignal):Promise<void>{await this.#run({kind:'Schema'},signal);}
 async read(thread:string,signal?:AbortSignal):Promise<PendingMirrorStartupIntent|null>{text(thread,16384,true);return this.#run({kind:'Read',thread},signal);}
 async retain(thread:string,cutoff:MirrorStartupCutoff,createdAt:number,operationId:string,signal?:AbortSignal):Promise<PendingMirrorStartupIntent>{
  const captured=MirrorStartupCutoff.prototype.captured.call(cutoff),intent=snapshotPendingMirrorStartupIntent({thread,cutoff:captured,createdAt,operationId});
  prepareMirrorStartupIntent(intent.thread,intent.cutoff,intent.createdAt,intent.operationId);
  const request={kind:'Retain',intent} as const,result=await this.#run(request,signal);
  if(result===null)throw new MirrorStartupIntentWriteUnconfirmedError(request,new TypeError('Missing retained startup intent'));return result;
 }
 #run(request:Request,signal?:AbortSignal):Promise<PendingMirrorStartupIntent|null>{
  signal?.throwIfAborted();if(this.#closed)throw new Error('Mirror startup intent store is closed');if(this.#inflight!==null)throw new OwnedWorkerBusyError();
  const controller=new AbortController();this.#controller=controller;const abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const operation=(async()=>{
   let submitted=false;
   try{
    const pending=this.#slot.run(new URL('./startup-intent-store-worker.ts',import.meta.url),{path:this.#path,...request},this.#timeout,controller.signal);submitted=this.#slot.busy;
    const exited=this.#slot.join();let response:unknown;try{response=await pending;}finally{await exited;}
    controller.signal.throwIfAborted();if(own(response,'ok')!==true){const detail=own(response,'detail');throw new MirrorStartupIntentStoreReadError(typeof detail==='string'?detail:'invalid native response');}
    const value=own(response,'value');return value===null?null:snapshotPendingMirrorStartupIntent(value as PendingMirrorStartupIntent);
   }catch(error){if(request.kind!=='Read'&&submitted)throw new MirrorStartupIntentWriteUnconfirmedError(request,error);throw error;}
   finally{signal?.removeEventListener('abort',abort);}
  })();
  this.#inflight=operation;void operation.then(()=>{this.#inflight=null;this.#controller=null;},()=>{this.#inflight=null;this.#controller=null;});return operation;
 }
}
