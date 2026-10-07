import {types} from "node:util";
import {admitPromptIntakeIn,snapshotNewPromptIntake,type NewPromptIntake,type PromptIntakeAdmission} from "./prompt-intake-write.ts";
import {withPromptIntakeWriter} from "./prompt-intake.ts";
import {getIngressIn} from "./ingress-read.ts";
import {newExecutionPrompt} from "./ingress-new-input.ts";
import {linkPromptOwnerByKeyIn} from "./ingress-prompt-ownership.ts";
import {markManagedTargetIn} from "./queue-managed-target.ts";
import {seedIn} from "./new-reply-seed.ts";
import {windowsNativePathToStringLossy,type WindowsNativePathInput} from "../core/windows-native-path.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeI64} from "./sqlite-values.ts";
export interface NewReplySeed {stateDb:WindowsNativePathInput;acknowledgement:string}
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed text");}
function snapshotSeed(value:NewReplySeed|null):NewReplySeed|null{
  if(value===null)return null;
  if(typeof value!=="object"||types.isProxy(value)||Array.isArray(value))throw new TypeError("Expected reply seed data");
  const path=Object.getOwnPropertyDescriptor(value,"stateDb"),ack=Object.getOwnPropertyDescriptor(value,"acknowledgement");
  if(!path||!ack||!Object.hasOwn(path,"value")||!Object.hasOwn(ack,"value"))throw new TypeError("Expected own seed data fields");
  const lossy=windowsNativePathToStringLossy(path.value);text(ack.value);
  // seed_in stores only the lossy string. Snapshot that value before opening storage.
  return {stateDb:{platform:"windows-utf16",units:Array.from({length:lossy.length},(_,i)=>lossy.charCodeAt(i))},acknowledgement:ack.value};
}
/** Save recorded creation, managed target, first-prompt ownership and optional reply seed atomically. */
export async function admitPromptIntakeWithIngress(path:string,input:NewPromptIntake,key:string,generation:bigint,reply:NewReplySeed|null=null):Promise<PromptIntakeAdmission>{
  const request=snapshotNewPromptIntake(input),seed=snapshotSeed(reply);text(key);
  if(typeof generation!=="bigint"||generation<-(1n<<63n)||generation>=(1n<<63n))throw new TypeError("Expected i64 generation");
  return withPromptIntakeWriter(path,db=>{
    const ingress=getIngressIn(db,key);if(ingress===null)throw new StoreIntegrityError(`missing new ingress: ${key}`);
    if(newExecutionPrompt(ingress)!==request.rawPrompt||ingress.eventId!==request.discordMessageId||ingress.ownerUserId!==request.ownerUserId)
      throw new StoreIntegrityError(`new prompt identity changed: ${key}`);
    const check=db.prepare(`SELECT state='executing' AND phase='thread/created' AND target_thread_id=?
      AND json_extract(outcome_json,'$.thread_start_generation')=? AS matched FROM discord_ingress_journal WHERE ingress_id=?`);check.setReadBigInts(true);
    if(decodeI64(check.get(request.targetThreadId,generation,key)?.matched,"matched")===0n)
      throw new StoreIntegrityError("thread creation has no matching recorded attempt");
    markManagedTargetIn(db,request.targetThreadId,generation,request.createdAt);
    const admitted=admitPromptIntakeIn(db,request);linkPromptOwnerByKeyIn(db,key,admitted.intake);
    if(seed!==null)seedIn(db,key,admitted.intake.jobId,seed.stateDb,seed.acknowledgement);
    return {value:admitted,commit:true};
  },false);
}
