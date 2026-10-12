import {captureBusyAdmission} from '../../store/prompt-intake-busy.ts';
import {captureNewAdmission,type NewReplySeed} from '../../store/prompt-intake-new-thread.ts';
import type {BusyChoice} from '../../store/busy-choice.ts';
import {types} from 'node:util';
import {snapshotNewPromptIntake,InvalidPromptIntakeIdentityError,type NewPromptIntake} from '../../store/prompt-intake-write.ts';
import {trimUnicodeWhitespace} from '../../store/queue-preflight-failure.ts';
import {DeadGenerationTargetHeldError} from '../../store/fork-completed-target.ts';
import {StateAccessFacade,type IStateAccessFacade} from '../../store/state-access-facade.ts';
import {InvalidPromptIntakeLeaseError,InvalidPromptIntakeRetryError,type PromptIntakeClaim,type StoredPromptIntake} from '../../store/prompt-intake.ts';
import {OwnedWorkerSlot} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {intakeNumberWire,intakeFromWire} from './native-wire.ts';
const LIMIT=16*1024*1024;
type Operation='Get'|'List'|'DurableOwner'|'Claim'|'Renew'|'RecordFailure'|'RemoveQueued'|'Admit'|'Canonicalize'|'ReleaseAll'|'AdmitBusy'|'AdmitWithIngress'|'MirrorTarget';
export class NativePromptIntakeUnavailableError extends Error{
 readonly operation:Operation;
 constructor(operation:Operation,cause:unknown){super('Prompt intake result unavailable after actual native join; no partial result or automatic retry',{cause});this.name='NativePromptIntakeUnavailableError';this.operation=operation;}
}
function lease(now:number,expires:number):void{
 if(typeof now!=='number'||typeof expires!=='number')throw new TypeError('Expected lease timestamps');
 if(!Number.isFinite(now)||!Number.isFinite(expires)||expires<=now)throw new InvalidPromptIntakeLeaseError(now,expires);
}
/** Exactly thirteen intake/mapping operations; all other state functions retain their identities. Shared finite Control admission; no new pool, retry or detached I/O. */
export function createNativePromptIntakeState(path:string,timeoutMs=5000):IStateAccessFacade{
 requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid intake store path');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid intake deadline');const fixed=pinNativeRuntimePath(path);
 const requirePath=(given:string)=>{if(given!==path)throw new TypeError('Intake facade differs from original installation binding');};
 const identity=(input:unknown):string=>{requireDiscordText(input);if(Buffer.byteLength(input)>65536)throw new RangeError('Intake identity exceeds native boundary');return input;};
 async function run<T>(operation:Operation,fields:object,decode:(value:unknown)=>T):Promise<T>{
  const data={path:fixed,operation,...fields};if(boundedSerdeByteCount(data,LIMIT)===null)throw new RangeError('Intake input exceeds native wire boundary');
  const slot=new OwnedWorkerSlot('Control');let admitted=false,raw:unknown;
  try{const pending=slot.run(new URL('./native-state-worker.ts',import.meta.url),data,timeoutMs);admitted=slot.busy;
   try{raw=await pending;}finally{await slot.join();}
  }catch(error){if(admitted)throw new NativePromptIntakeUnavailableError(operation,error);throw error;}
  let refusal:DeadGenerationTargetHeldError|undefined;
  try{
   if(boundedSerdeByteCount(raw,LIMIT)===null||own(raw,'operation')!==operation)throw new TypeError('No complete bound intake acknowledgement');
   if(own(raw,'ok')===true)return decode(own(raw,'value'));
   if((operation==='Admit'||operation==='Canonicalize'||operation==='AdmitBusy'||operation==='AdmitWithIngress')&&own(raw,'kind')==='DeadTargetHeld'){
    if(own(raw,'id')!==own(fields,'id'))throw new TypeError('Held target refusal differs from captured intake');
    const target=own(raw,'target');requireDiscordText(target);refusal=new DeadGenerationTargetHeldError(target);
   }else throw new TypeError('No complete bound intake acknowledgement');
  }catch(error){throw new NativePromptIntakeUnavailableError(operation,error);}
  throw refusal;
 }
 function claimed(raw:unknown,id:string,expires:number,token:string|null):PromptIntakeClaim|null{
  if(raw===null)return null;const current=identity(own(raw,'claimToken')),intake=intakeFromWire(own(raw,'intake'));
  if((token===null&&current==='')||intake.jobId!==id||intake.claimToken!==current||intake.claimExpiresAt!==expires||(token!==null&&current!==token))throw new TypeError('Claim result differs from request');
  return {intake,claimToken:current};
 }
 return Object.freeze({...StateAccessFacade,
  async mirroredThreadId(given:string,channel:bigint|null){
   requirePath(given);if(channel!==null&&(typeof channel!=='bigint'||channel<-(1n<<63n)||channel>=(1n<<63n)))throw new TypeError('Expected optional i64 channel');
   if(channel===null||channel===0n)return null;
   return run('MirrorTarget',{channel},raw=>{if(own(raw,'channel')!==channel)throw new TypeError('Mirror reply differs from captured room');const target=own(raw,'target');if(target===null)return null;requireDiscordText(target);return target;});
  },
  async admitBusyQueue(given:string,input:BusyChoice,target:string,requireCurrentMirror:boolean,confirmationKey:string,now:number){
   requirePath(given);const {choice,jobId}=captureBusyAdmission(input,target,requireCurrentMirror,confirmationKey,now);identity(jobId);identity(target);identity(confirmationKey);
   return run('AdmitBusy',{id:jobId,choice:{...choice,createdAt:intakeNumberWire(choice.createdAt),expiresAt:intakeNumberWire(choice.expiresAt)},target,requireCurrentMirror,confirmationKey,now},raw=>{
    if(own(raw,'jobId')!==jobId)throw new TypeError('Busy admission reply differs from captured job');const value=own(raw,'intake');if(value===null)return {jobId,intake:null};const intake=intakeFromWire(value);
    if(intake.jobId!==jobId||intake.targetThreadId!==target||intake.channelId!==choice.channelId||intake.ownerUserId!==choice.ownerUserId||intake.discordMessageId!==null||intake.rawPrompt!==choice.prompt||!intake.autoQueueWhenBusy||intake.requireCurrentMirror!==requireCurrentMirror)throw new TypeError('Busy intake differs from captured choice');return {jobId,intake};
   });
  },
  async admitPromptIntakeWithIngress(given:string,input:NewPromptIntake,key:string,generation:bigint,reply:NewReplySeed|null=null){
   requirePath(given);const {request,seed}=captureNewAdmission(input,key,generation,reply);identity(request.jobId);identity(key);
   return run('AdmitWithIngress',{id:request.jobId,request:{...request,createdAt:intakeNumberWire(request.createdAt)},key,generation,seed},raw=>{
    const created=own(raw,'created');if(typeof created!=='boolean')throw new TypeError('Expected new admission created boolean');const intake=intakeFromWire(own(raw,'intake'));
    if(intake.discordMessageId!==request.discordMessageId||(request.discordMessageId===null&&intake.jobId!==request.jobId))throw new TypeError('New admission reply differs from captured message');
    if(created&&(intake.jobId!==request.jobId||intake.channelId!==request.channelId||intake.ownerUserId!==request.ownerUserId||intake.rawPrompt!==request.rawPrompt||intake.autoQueueWhenBusy!==request.autoQueueWhenBusy||intake.requireCurrentMirror!==request.requireCurrentMirror))throw new TypeError('New admission differs from captured request');return {created,intake};
   });
  },
  // Caller must retain exclusive startup ownership; periodic recovery never calls this.
  async releaseAllPromptIntakeClaims(given:string){requirePath(given);return run('ReleaseAll',{},raw=>{if(typeof raw!=='bigint'||raw<0n)throw new TypeError('Expected nonnegative released-intake count');return raw;});},
  async admitPromptIntake(given:string,input:NewPromptIntake){
   requirePath(given);const request=snapshotNewPromptIntake(input);
   if(request.jobId===''||trimUnicodeWhitespace(request.jobId)!==request.jobId||request.targetThreadId===''||trimUnicodeWhitespace(request.targetThreadId)!==request.targetThreadId)throw new InvalidPromptIntakeIdentityError(request.jobId,request.targetThreadId);
   identity(request.jobId);identity(request.targetThreadId);
   return run('Admit',{id:request.jobId,request:{...request,createdAt:intakeNumberWire(request.createdAt)}},raw=>{
    const created=own(raw,'created');if(typeof created!=='boolean')throw new TypeError('Expected admission created boolean');const intake=intakeFromWire(own(raw,'intake'));
    // A message duplicate deliberately preserves the older job and all stored fields.
    if(intake.discordMessageId!==request.discordMessageId||(request.discordMessageId===null&&intake.jobId!==request.jobId))throw new TypeError('Admission reply differs from captured identity');
    if(created&&(intake.jobId!==request.jobId||intake.channelId!==request.channelId||intake.ownerUserId!==request.ownerUserId||intake.rawPrompt!==request.rawPrompt||intake.autoQueueWhenBusy!==request.autoQueueWhenBusy||intake.requireCurrentMirror!==request.requireCurrentMirror))throw new TypeError('Created admission differs from captured request');
    return {created,intake};
   });
  },
  async canonicalizePromptIntakeTarget(given:string,id:string){requirePath(given);const key=identity(id);return run('Canonicalize',{id:key},raw=>{if(raw===null)return null;const row=intakeFromWire(raw);if(row.jobId!==key)throw new TypeError('Canonical reply differs from captured intake');return row;});},
  async recordPromptIntakeFailureIfClaimed(given:string,claim:PromptIntakeClaim,error:string,retryAfter:number){
   requirePath(given);if(typeof retryAfter!=='number')throw new TypeError('Expected retry timestamp');if(!Number.isFinite(retryAfter))throw new InvalidPromptIntakeRetryError(retryAfter);requireDiscordText(error);
   const id=identity(own(own(claim,'intake'),'jobId')),token=identity(own(claim,'claimToken'));
   return run('RecordFailure',{id,token,error,retryAfter},raw=>{if(raw===null)return null;const row=intakeFromWire(raw);if(row.jobId!==id)throw new TypeError('Failure result differs from captured intake');return row;});
  },
  async removePromptIntakeIfQueued(given:string,id:string){requirePath(given);const key=identity(id);return run('RemoveQueued',{id:key},raw=>{if(typeof raw!=='boolean')throw new TypeError('Expected exact intake removal result');return raw;});},
  async getPromptIntake(given:string,id:string){requirePath(given);const key=identity(id);return run('Get',{id:key},raw=>{if(raw===null)return null;const value=intakeFromWire(raw);if(value.jobId!==key)throw new TypeError('Intake result differs from requested job');return value;});},
  async listPromptIntakes(given:string,readyAt:number|null=null){requirePath(given);if(readyAt!==null&&typeof readyAt!=='number')throw new TypeError('Expected readiness timestamp');
   return run('List',{readyAt:readyAt===null?null:intakeNumberWire(readyAt)},raw=>{if(types.isProxy(raw)||!Array.isArray(raw))throw new TypeError('Expected complete intake vector');const result:StoredPromptIntake[]=[];for(let i=0;i<raw.length;i++)result.push(intakeFromWire(own(raw,String(i))));return result;});},
  async promptIntakeHasDurableOwner(given:string,id:string){requirePath(given);const key=identity(id);return run('DurableOwner',{id:key},raw=>{if(typeof raw!=='boolean')throw new TypeError('Expected exact durable-owner boolean');return raw;});},
  async tryClaimPromptIntake(given:string,id:string,now:number,expires:number){requirePath(given);const key=identity(id);lease(now,expires);return run('Claim',{id:key,now,expires},raw=>claimed(raw,key,expires,null));},
  async renewPromptIntakeClaimIfCurrent(given:string,claim:PromptIntakeClaim,now:number,expires:number){requirePath(given);lease(now,expires);const id=identity(own(own(claim,'intake'),'jobId')),token=identity(own(claim,'claimToken'));return run('Renew',{id,token,now,expires},raw=>claimed(raw,id,expires,token));},
 });
}
