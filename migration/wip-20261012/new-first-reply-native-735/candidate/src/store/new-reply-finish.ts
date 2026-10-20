import {CheckedRead} from './owned-driver.ts';
import {getNewReplyByIngress,getNewReplyByIngressIn,getIn,validateNewReplyIngress,type NewReply} from './new-reply-read.ts';
import {validateNewReplyCurrent,validateNewReplyIdentityIn} from './new-reply-claims.ts';
import type {DatabaseSync} from 'node:sqlite';
export interface NewFirstReplyFinish {readonly jobId:string;readonly turnId:string|null;readonly acknowledgement:string}
function project(record:NewReply):NewFirstReplyFinish{return {jobId:record.identity.job_id,turnId:record.turnId,acknowledgement:record.identity.acknowledgement};}
/** Original ordered reads. This is a finish-notification projection, not a delivery claim. */
export async function getNewFirstReplyFinish(path:string,ingress:string):Promise<NewFirstReplyFinish|null>{
 const record=await getNewReplyByIngress(path,ingress);if(record===null)return null;
 await validateNewReplyCurrent(path,record.identity.job_id);return project(record);
}
function read<T>(path:string,work:(db:DatabaseSync)=>T):T{const owner=CheckedRead.open(path);try{const result=work(owner.connection());owner.finish();return result;}finally{owner.close();}}
/** Preserve two separate read lifetimes and full original decode before projecting. */
export function getNewFirstReplyFinishExisting(path:string,ingress:string):NewFirstReplyFinish|null{
 validateNewReplyIngress(ingress);const record=read(path,db=>getNewReplyByIngressIn(db,ingress));if(record===null)return null;
 read(path,db=>{const current=getIn(db,record.identity.job_id);if(current!==null)validateNewReplyIdentityIn(db,current);});return project(record);
}
