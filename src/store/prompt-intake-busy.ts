import type {DatabaseSync} from "node:sqlite";
import {snapshotBusyChoice,serializeBusyChoice,verifyBusyChoiceRouteIn,BusyChoiceUnavailableError,type BusyChoice} from "./busy-choice.ts";
import {withPromptIntakeWriter,type StoredPromptIntake} from "./prompt-intake.ts";
import {admitPromptIntakeIn} from "./prompt-intake-write.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeI64} from "./sqlite-values.ts";
export interface BusyQueueAdmission {jobId:string;intake:StoredPromptIntake|null}
function recordBusyOwnerIn(db:DatabaseSync,choice:BusyChoice,job:string,target:string,now:number):void{
  const canonical=`busy-choice:${choice.choiceId}`;
  db.prepare(`INSERT INTO discord_ingress_owner_receipts(owner_key,owner_kind,owner_id,target_thread_id,channel_id,owner_user_id,payload_json,created_at)
    VALUES (?,'prompt',?,?,?,?,?,?) ON CONFLICT(owner_key) DO NOTHING`).run(canonical,job,target,choice.channelId,choice.ownerUserId,serializeBusyChoice(choice),now);
  db.prepare(`UPDATE discord_ingress_journal SET state='owned',phase='durable_prompt',owner_kind='prompt',owner_id=?,target_thread_id=?,updated_at=?
    WHERE canonical_owner=? AND channel_id=? AND owner_user_id=?`).run(job,target,now,canonical,choice.channelId,choice.ownerUserId);
}
/** Only an admission returning intake may start preparation; a receipt repeat must not replay work. */
export async function admitBusyQueue(path:string,input:BusyChoice,target:string,requireCurrentMirror:boolean,confirmationKey:string,now:number):Promise<BusyQueueAdmission>{
  const choice=snapshotBusyChoice(input);
  for(const text of [target,confirmationKey])if(typeof text!=="string"||/[\uD800-\uDFFF]/u.test(text))throw new TypeError("Expected well-formed text");
  if(typeof now!=="number"||typeof requireCurrentMirror!=="boolean")throw new TypeError("Expected route mode/timestamp");
  if(!Number.isFinite(now)||now<0||confirmationKey==="")throw new StoreIntegrityError("invalid busy queue admission");
  const jobId=`busy-choice:${choice.choiceId}`;
  return withPromptIntakeWriter<BusyQueueAdmission>(path,db=>{
    if(choice.targetThreadId!==target)throw new BusyChoiceUnavailableError(choice.choiceId);
    const receipt=db.prepare("SELECT EXISTS(SELECT 1 FROM persistent_component_claims WHERE claim_key=? AND expires_at>?) AS accepted");receipt.setReadBigInts(true);
    if(decodeI64(receipt.get(confirmationKey,now)?.accepted,"accepted")!==0n){recordBusyOwnerIn(db,choice,jobId,target,now);return {value:{jobId,intake:null},commit:true};}
    const route=db.prepare("SELECT require_current_mirror AS mapped FROM busy_choices WHERE choice_id=?");route.setReadBigInts(true);const row=route.get(choice.choiceId);
    if(row===undefined||row.mapped===null)throw new BusyChoiceUnavailableError(choice.choiceId);
    const mapped=decodeI64(row.mapped,"require_current_mirror")!==0n;verifyBusyChoiceRouteIn(db,choice.channelId,choice.targetThreadId,mapped);
    if(mapped!==requireCurrentMirror)throw new StoreIntegrityError("busy prompt route mode changed; no request accepted");
    const claimed=db.prepare(`UPDATE busy_choices SET claimed_at=? WHERE choice_id=? AND claimed_at IS NULL AND expires_at>?
      AND owner_user_id=? AND channel_id=? AND target_thread_id IS ? AND prompt=? AND allow_steer=? AND created_at=? AND expires_at=?`)
      .run(now,choice.choiceId,now,choice.ownerUserId,choice.channelId,choice.targetThreadId,choice.prompt,Number(choice.allowSteer),choice.createdAt,choice.expiresAt).changes;
    if(BigInt(claimed)!==1n)throw new BusyChoiceUnavailableError(choice.choiceId);
    const admitted=admitPromptIntakeIn(db,{jobId,targetThreadId:target,channelId:choice.channelId,ownerUserId:choice.ownerUserId,discordMessageId:null,
      rawPrompt:choice.prompt,autoQueueWhenBusy:true,requireCurrentMirror,createdAt:now});
    if(admitted.intake.targetThreadId!==target)throw new StoreIntegrityError("busy prompt target changed during admission; no request accepted");
    if(!admitted.created)throw new StoreIntegrityError(`busy queue ${jobId} already has an intake without an acceptance receipt`);
    db.prepare(`INSERT INTO persistent_component_claims(claim_key,created_at,expires_at) VALUES (?,?,?) ON CONFLICT(claim_key)
      DO UPDATE SET created_at=excluded.created_at,expires_at=excluded.expires_at`).run(confirmationKey,now,Math.max(choice.expiresAt,now+1800));
    recordBusyOwnerIn(db,choice,jobId,target,now);return {value:{jobId,intake:admitted.intake},commit:true};
  },false);
}
