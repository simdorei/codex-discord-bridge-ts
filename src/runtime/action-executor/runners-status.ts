import {StateAccessFacade} from '../../store/state-access-facade.ts';
import {requireDiscordText} from '../../discord/text.ts';
/** Source-order independent store reads, not an atomic all-table dashboard.
 * Reporting holds and receipts never clears them or automatically retries work. */
export async function runnersMessage(path:string,signal?:AbortSignal):Promise<string>{
 requireDiscordText(path);signal?.throwIfAborted();const jobs=await StateAccessFacade.listQueueJobs(path);signal?.throwIfAborted();const pending=(await StateAccessFacade.listPendingDeliveries(path)).length;signal?.throwIfAborted();const unknown=await StateAccessFacade.unknownDeliveryReceiptCount(path);signal?.throwIfAborted();const blocked=await StateAccessFacade.blockedDeliveryReceiptCount(path);signal?.throwIfAborted();const intakes=await StateAccessFacade.listPromptIntakes(path);signal?.throwIfAborted();const held:string[]=[];
 for(const id of [...jobs.map(j=>j.jobId),...intakes.map(i=>i.jobId)]){const reason=await StateAccessFacade.executionHoldReason(path,id);signal?.throwIfAborted();if(reason!==null){const row=`${id}: ${reason}`;if(!held.includes(row))held.push(row);}}
 const count=(state:string)=>jobs.filter(j=>j.state===state).length,backoff=intakes.filter(i=>i.lastError!=='').length;
 return `Codex runners\nexecution_held (explicit recovery required): ${held.length===0?'none':held.join('\n')}\npending: ${count('Pending')}\nstarting: ${count('Starting')}\nrunning: ${count('Running')}\nquarantined: ${count('Quarantined')}\nfinal_pending: ${pending}\nsends_unconfirmed: ${unknown} (not automatically resent)\nsends_rejected: ${blocked} (requires correction; no automatic retry)\nrecoverable_intakes: ${intakes.length}\nintake_backoff: ${backoff}`;
}
