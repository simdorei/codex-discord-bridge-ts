import {types} from 'node:util';
import {requireDiscordText} from '../../discord/text.ts';
export const STARTUP_NOTICE_DOMAIN='runtime/startup-notice/v1';
/** One process boot key, reused across reconnects. This state does not generate
 * credentials, send HTTP or claim permanent server deduplication. Exclusive
 * mutable access is explicit: overlapping sends reject before invoking a callback.
 * Failed/unconfirmed sends remain retryable under the same logical nonce. */
export class StartupNoticeState{
 readonly logicalKey:string;#delivered=false;#busy=false;
 constructor(logicalKey:string){if(new.target!==StartupNoticeState)throw new TypeError('Expected exact startup notice state');requireDiscordText(logicalKey);this.logicalKey=logicalKey;Object.freeze(this);}
 async trySend(send:()=>Promise<void>):Promise<boolean>{
  if(this.#busy)throw new TypeError('Concurrent startup notice send');if(this.#delivered)return false;
  if(typeof send!=='function'||types.isProxy(send)||types.isGeneratorFunction(send))throw new TypeError('Expected startup notice callback');this.#busy=true;
  try{const pending=send();if(!types.isPromise(pending))throw new TypeError('Startup notice must return a Promise');const value:unknown=await pending;if(value!==undefined)throw new TypeError('Startup notice completion must be void');this.#delivered=true;return true;}finally{this.#busy=false;}
 }
}
