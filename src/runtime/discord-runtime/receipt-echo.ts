import {isDecodedGatewayMessage,type DecodedGatewayMessage} from '../../discord/gateway/decoded-message.ts';
import {OwnedWorkerSlot} from '../owned-worker-slot.ts';
/** Only authentic bot Gateway messages can reconcile an already-persisted send
 * intent. This path never submits/retries an HTTP request or a Codex mutation. */
export async function confirmGatewayReceiptEcho(database:string,message:DecodedGatewayMessage,bot:bigint|null,signal?:AbortSignal):Promise<boolean>{
 if(!isDecodedGatewayMessage(message))throw new TypeError('Expected decoded Gateway message');
 const author=message.author as {id:bigint;bot:boolean};
 if(bot===null||author.id!==bot||author.bot!==true||message.webhook_id!==null||message.edited_timestamp!==null||typeof message.nonce!=='bigint')return false;
 const slot=new OwnedWorkerSlot();try{
  const result=await slot.run(new URL('./receipt-echo-worker.ts',import.meta.url),{database,message},10000,signal) as {ok:boolean;confirmed?:boolean};
  if(result.ok!==true)throw new Error('Gateway receipt reconciliation failed; persisted intent retained');return result.confirmed===true;
 }finally{await slot.join();}
}
