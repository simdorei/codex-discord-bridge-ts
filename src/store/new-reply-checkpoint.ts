import type {DatabaseSync} from 'node:sqlite';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {requireDiscordText} from '../discord/text.ts';
import {getIn,type NewReply,type Identity} from './new-reply-read.ts';
import {validateNewReplyIdentityIn} from './new-reply-claims.ts';
import {parseNewReplyIdentity} from './new-reply-identity.ts';
import {usingInitializedStore,withStoreTransaction,commitStore,rollbackStore} from './owned-scope.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
export interface NewReplyCheckpointUpdate{readonly scan:unknown;readonly verified:boolean;readonly error:string;readonly now:number;}
const keys:readonly(keyof Identity)[]=['ingress_id','job_id','thread_id','cwd','state_db','channel_id','origin_channel_id','event_id','kind','creation_generation','prompt_sha256','acknowledgement'];
/** Source checkpoint transaction. This internal store port trusts verified input
 * from an authorized verifier; it does not turn arbitrary cursor data into proof.
 * Synchronous SQLite remains explicit and must be hosted off the event loop for
 * the runtime worker. No HTTP or filesystem work occurs in this transaction. */
function capture(input:NewReply,update:NewReplyCheckpointUpdate){
 const now=own(update,'now');if(typeof now!=='number'||!Number.isFinite(now))throw new StoreIntegrityError('invalid verification timestamp');
 const verified=own(update,'verified'),error=own(update,'error'),scan=own(update,'scan');
 if(typeof verified!=='boolean')throw new TypeError('Expected verification boolean');if(typeof error!=='string'||Buffer.byteLength(error)>65536)throw new RangeError('New reply error exceeds diagnostic budget');requireDiscordText(error);
 if(boundedSerdeByteCount(input,1048576)===null||boundedSerdeByteCount(scan,262144)===null)throw new RangeError('New reply checkpoint input budget exceeded');
 const original=cloneOwnedSerdeValue(input) as NewReply,id=parseNewReplyIdentity(serializeSerdeValue(own(original,'identity'))),version=own(original,'version'),turn=own(original,'turnId');
 if(typeof version!=='bigint'||version<-(1n<<63n)||version>=(1n<<63n))throw new TypeError('Expected i64 new reply revision');if(turn!==null)requireDiscordText(turn);
 const scanJson=serializeSerdeValue(scan);return Object.freeze({id,version,turn,scanJson,verified,error,now});
}
function apply(db:DatabaseSync,c:ReturnType<typeof capture>):boolean{
 const {id,version,turn,scanJson,verified,error,now}=c;
 return withStoreTransaction(db,'IMMEDIATE',()=>{
  const current=getIn(db,id.job_id);if(current===null)throw new StoreIntegrityError('new intent disappeared');
  if(current.version!==version||current.turnId!==turn||!keys.every(k=>current.identity[k]===id[k]))return rollbackStore(false);
  let identityError:string|undefined;try{validateNewReplyIdentityIn(db,current);}catch(cause){identityError=cause instanceof Error?cause.message:'new first-reply identity validation failed';}
  const overdue=current.acceptedAt!==null&&now>=current.acceptedAt+120;
  const deadlineError=error===''&&overdue&&!verified&&current.state!=='verified'?'new first input has not been verified after 120 seconds; execution is preserved':error;
  const finalError=identityError??deadlineError,state=finalError!==''?'review_required':verified||current.state==='verified'?'verified':'pending',warning=overdue&&(state!=='verified'||!current.confirmationDelivered);
  let shortError='',count=0;for(const scalar of finalError){if(count++===1000)break;shortError+=scalar;}
  const changed=db.prepare('UPDATE codex_new_first_replies SET state=?,scan_json=?,last_error=?,checked_at=?,version=version+1,warning_due=MAX(warning_due,?) WHERE job_id=? AND version=?').run(state,scanJson,shortError,now,warning?1n:0n,id.job_id,version);
  if(BigInt(changed.changes)!==1n)throw new StoreIntegrityError('new checkpoint lost its original revision');
  return commitStore(true);
 });
}
export function checkpointNewReplyIn(db:DatabaseSync,original:NewReply,update:NewReplyCheckpointUpdate):boolean{return apply(db,capture(original,update));}
/** Owned source-compatible wrapper; captures inputs before opening asynchronously.
 * Native hosting is a separate runtime port. */
export async function checkpointNewReply(path:string,original:NewReply,update:NewReplyCheckpointUpdate):Promise<boolean>{
 requireDiscordText(path);const captured=capture(original,update);
 return usingInitializedStore(path,db=>apply(db,captured));
}
