import {targetIsHeldIn,generationIsSealedIn} from './dead-generation-admission.ts';
import {types} from 'node:util';
import type {DatabaseSync} from 'node:sqlite';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {sha256SerdeValue} from '../core/serde-json.ts';
import {requireDiscordText} from '../discord/text.ts';
import {openExisting} from './existing-store.ts';
import {ownerIsCurrent,type NewAttempt} from './mutation-attempt.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
const empty=/^[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$/;
function refuse(message:string):never{throw new StoreIntegrityError(message);}
/** Final SYNCHRONOUS read guard for a known committed original intent. This is
 * not a native/off-thread optimization or a new send permission. It excludes
 * only the exact original row, rechecks original durable authority in the same
 * read transaction, and creates/repairs/updates nothing. The caller must use its
 * owned receipt, then immediately revalidate in-memory authority before writing.
 * SQLite busy timeout is zero; filesystem/OS latency is still not bounded here. */
export function revalidatePreparedMutation(path:string,input:NewAttempt,authorityCheck:(db:DatabaseSync)=>undefined):void{
 if(typeof authorityCheck!=='function'||types.isProxy(authorityCheck)||types.isAsyncFunction(authorityCheck)||types.isGeneratorFunction(authorityCheck))throw new TypeError('Expected synchronous original authority check');
 if(boundedSerdeByteCount(input,2097152)===null)throw new RangeError('Prepared mutation evidence exceeds read boundary');
 const value=cloneOwnedSerdeValue(input),keys=['runtimeId','ownerId','generation','attemptId','wireId','method','targetThreadId','scoped','payload'];
 if(value===null||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new TypeError('Expected exact original mutation evidence');
 const c=value as NewAttempt;
 for(const v of [c.runtimeId,c.ownerId,c.attemptId,c.wireId,c.method]){requireDiscordText(v);if(empty.test(v))refuse('invalid original mutation identity');}
 if(c.targetThreadId!==null)requireDiscordText(c.targetThreadId);
 if(typeof c.generation!=='bigint'||c.generation<1n||c.generation>((1n<<63n)-1n)||typeof c.scoped!=='boolean'||(c.scoped&&(c.targetThreadId===null||empty.test(c.targetThreadId))))refuse('invalid original mutation scope');
 const hash=sha256SerdeValue(c.payload),db=openExisting(path,0);
 try{
  db.exec('PRAGMA query_only=ON; BEGIN');ownerIsCurrent(db,c.runtimeId);
  const exact=db.prepare("SELECT count(*) AS n FROM codex_mutation_attempts WHERE attempt_id=?1 AND runtime_id=?2 AND owner_id=?3 AND generation=?4 AND wire_id=?5 AND method=?6 AND target_thread_id IS ?7 AND scoped=?8 AND request_sha256=?9 AND state='prepared'");exact.setReadBigInts(true);
  if(exact.get(c.attemptId,c.runtimeId,c.ownerId,c.generation,c.wireId,c.method,c.targetThreadId,c.scoped?1:0,hash)?.n!==1n)refuse('original prepared mutation is missing or changed');
  const other=db.prepare("SELECT EXISTS(SELECT 1 FROM codex_mutation_attempts WHERE state='prepared' AND attempt_id<>?1 AND (?2 IS NULL OR scoped=0 OR target_thread_id=?2)) AS held");other.setReadBigInts(true);
  if(other.get(c.attemptId,c.scoped?c.targetThreadId:null)?.held!==0n)refuse('another prepared mutation blocks original dispatch');
  const checked=authorityCheck(db);
  if(types.isPromise(checked))void Promise.prototype.then.call(checked,undefined,()=>undefined);
  if(checked!==undefined)refuse('original authority check did not complete synchronously');
  if(!db.isTransaction)refuse('original authority read transaction ended unexpectedly');
  ownerIsCurrent(db,c.runtimeId);db.exec('COMMIT');
 }finally{db.close();}
}

/** Same durable target/generation predicates used before ordinary resident mutation.
 * Borrowed final-read handle: no transaction management, repair, or writes. */
export function requireFinalDeadGenerationUnheldIn(db:DatabaseSync,method:string,target:string|null,generation:bigint):void{
 requireDiscordText(method);if(target!==null)requireDiscordText(target);
 if(!['thread/resume','thread/fork','turn/start','turn/steer'].includes(method))return;
 if(target!==null&&targetIsHeldIn(db,target))refuse('app-server target is durably held');
 if(generationIsSealedIn(db,generation))refuse('app-server generation is durably sealed');
}
