import {openInitialized} from "./owned-driver.ts";
import {receiptText,receiptTextColumns} from "./delivery-receipt-key.ts";
import {decodeI64} from "./sqlite-values.ts";
export const START_NOTICE_DOMAIN="reserve/start-failure/v1";
export interface StartNotice{readonly jobId:string;readonly threadId:string;readonly channelId:bigint;readonly content:string}
/** Historical no-turn rejection notices only; never starts work or switches models. */
export async function pendingStartNotices(path:string):Promise<StartNotice[]>{
  const db=await openInitialized(path);try{
    const q=db.prepare(`SELECT job_id,target_thread_id,channel_id,content,${receiptTextColumns("job_id","target_thread_id","content")} FROM codex_reserve_start_notices ORDER BY created_at,job_id`);q.setReadBigInts(true);
    return Array.from(q.iterate(),row=>({jobId:receiptText(row,"job_id")!,threadId:receiptText(row,"target_thread_id")!,channelId:decodeI64(row.channel_id,"channel_id"),content:receiptText(row,"content")!}));
  }finally{db.close();}
}
export async function completeStartNotice(path:string,job:string):Promise<void>{
  if(typeof job!=="string"||/[\uD800-\uDFFF]/u.test(job))throw new TypeError("Expected well-formed job identity");
  const db=await openInitialized(path);try{db.prepare("DELETE FROM codex_reserve_start_notices WHERE job_id=?").run(job);}finally{db.close();}
}
