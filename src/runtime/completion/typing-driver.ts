import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import {StateAccessFacade as state} from "../../store/state-access-facade.ts";
import {invokeSynchronousVoid} from "../../core/synchronous-void.ts";
import {DelayedTicks,type TickSource} from "../delayed-ticks.ts";
import {sendTyping,type TypingBackend,type TypingTransport,type TypingInventoryReader} from "./typing.ts";
import {TerminalFence} from "./terminal-fence.ts";
type Server=Pick<PortableResidentLifecycle,'generation'|'subscribeLifecycleChanges'|'lifecycleSnapshot'|'activeTurnId'>;
/** A lifecycle change is sticky for this typing pass even after the underlying watch
 * consumes its notification. Equal-generation publications and closure also revoke. */
export function residentTypingBackend(server:Server):TypingBackend{
 return {generation:()=>server.generation(),lifecycleSnapshot:async()=>server.lifecycleSnapshot(),activeTurnId:async target=>server.activeTurnId(target),subscribeLifecycle:()=>{
  const watch=server.subscribeLifecycleChanges();let changed=false;
  return {hasChanged:()=>changed||watch.hasChangedOrClosed(),changed:async signal=>{try{await watch.changed(signal);changed=true;}catch(error){if(!signal?.aborted||error!==signal.reason)changed=true;throw error;}},dispose:()=>{changed=true;watch.dispose();}};
 }};
}
/** Owned six-second delayed typing loop, independent from completion processing.
 * Trusted transport must stop dispatch/settle on abort. Shutdown joins that promise,
 * rather than pretending Rust future Drop can forcibly cancel arbitrary JavaScript IO. */
export class CompletionTypingDriver{
 readonly #path:string;readonly #server:TypingBackend;readonly #fence:TerminalFence;readonly #transport:TypingTransport;readonly #report:(error:unknown)=>void;readonly #native:TypingInventoryReader|undefined;#used=false;
 constructor(path:string,server:TypingBackend,fence:TerminalFence,transport:TypingTransport,report:(error:unknown)=>void,native?:TypingInventoryReader){this.#native=native;this.#path=path;this.#server=server;this.#fence=fence;this.#transport=transport;this.#report=report;}
 async run(signal:AbortSignal,ticks:TickSource=new DelayedTicks(6000)):Promise<void>{
  if(this.#used){ticks.close();throw new TypeError('Typing driver already used');}this.#used=true;
  let stop!:()=>void,pending:Promise<{kind:'tick'}|{kind:'error';error:unknown}>|undefined;const stopped=new Promise<{kind:'stop'}>(resolve=>{stop=()=>resolve({kind:'stop'});});signal.addEventListener('abort',stop,{once:true});
  try{while(!signal.aborted){try{await sendTyping(this.#path,this.#server,this.#fence,this.#transport,state,signal,this.#native);}catch(error){if(signal.aborted&&error===signal.reason)break;invokeSynchronousVoid(this.#report,{},[error]);}if(signal.aborted)break;pending=ticks.wait().then(()=>({kind:'tick' as const}),error=>({kind:'error' as const,error}));const next=await Promise.race([pending,stopped]);if(next.kind==='stop')break;if(next.kind==='error')throw next.error;}}
  finally{ticks.close();signal.removeEventListener('abort',stop);if(pending)await pending;}
 }
}
