import {requireDiscordText} from '../discord/text.ts';
import {types} from 'node:util';
import {openInitialized} from './owned-driver.ts';
import {withStoreTransaction,commitStore} from './owned-scope.ts';
import {invokeSynchronousVoid} from '../core/synchronous-void.ts';
/** Prepare the connection before entering a synchronous publication fence. The
 * fence must invoke the supplied operation once, synchronously. SQL errors are
 * rethrown AFTER leaving the fence so an ordinary SQLite error is not confused
 * with a panicking fence callback. Invalid guards roll back the unique marker.
 *
 * Deliberate TS ordering boundary: initialization and BEGIN IMMEDIATE occur
 * before the final fence check; no processed marker is written until that check.
 * DatabaseSync remains on the current thread, not an offload/performance claim. */
export async function claimProcessedMessageGuarded(path:string,messageId:bigint,now:number,guard:(operation:()=>void)=>void):Promise<boolean>{
 requireDiscordText(path);if(typeof messageId!=='bigint'||messageId<-(1n<<63n)||messageId>=1n<<63n)throw new TypeError('Expected i64 message identity');
 if(typeof now!=='number')throw new TypeError('Expected numeric timestamp');
 if(typeof guard!=='function'||types.isProxy(guard)||types.isAsyncFunction(guard)||types.isGeneratorFunction(guard))throw new TypeError('Expected synchronous processed-claim guard');
 const db=await openInitialized(path);
 try{return withStoreTransaction(db,'IMMEDIATE',()=>{
  let called=false,active=true,violated=false,result=false,failed=false,error:unknown;
  const operation=()=>{if(!active||called){violated=true;throw new TypeError('Processed claim operation is expired or already consumed');}called=true;try{result=db.prepare('INSERT OR IGNORE INTO discord_processed_messages (message_id, seen_at) VALUES (?, ?)').run(messageId,now).changes===1;}catch(failure){failed=true;error=failure;}};
  try{invokeSynchronousVoid(guard,{},[operation]);}finally{active=false;}
  if(violated)throw new TypeError('Processed claim operation was invoked more than once');if(!called)throw new TypeError('Processed claim guard did not invoke operation');if(failed)throw error;return commitStore(result);
 });}finally{db.close();}
}
