import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {normalizeWorkspacePathPosix} from '../../codex-state/thread-reference.ts';
import type {ThreadInfo} from '../../codex-state/thread.ts';
import type {NewReply} from '../../store/new-reply-read.ts';
import {parseNewReplyIdentity} from '../../store/new-reply-identity.ts';
import {readNewReplyThreadOffThread} from './thread-reader.ts';
import {beginNewReplyFileCursor,observeNewReplyFile,decodeNewReplyFileCursor,encodeNewReplyFileCursor,type NewReplyFileObservation,type NewReplyFileCursor} from './file-observation.ts';
const TOKEN=Symbol('owned new reply inspection'),FORMAT='cdr-new-reply-cursor/v2';
function capture(input:NewReply):NewReply{
 if(boundedSerdeByteCount(input,1048576)===null)throw new RangeError('New reply record exceeds inspection budget');
 const value=cloneOwnedSerdeValue(input) as NewReply;parseNewReplyIdentity(serializeSerdeValue(own(value,'identity')));
 if(value.turnId!==null)requireDiscordText(value.turnId);
 if(!['pending','review_required','verified'].includes(value.state)||typeof value.version!=='bigint')throw new TypeError('Invalid durable new reply inspection state');
 return value;
}
function sameThread(a:ThreadInfo|null,b:ThreadInfo|null):boolean{return a===null?b===null:b!==null&&a.id===b.id&&a.cwd===b.cwd&&a.rolloutPath===b.rolloutPath;}
export class NewReplyInspection{
 readonly #original:NewReply;readonly #scan:unknown;readonly #verified:boolean;readonly #thread:ThreadInfo|null;readonly #file:NewReplyFileObservation|null;readonly #alreadyVerified:boolean;
 readonly historyIntegrityVerified=false;
 constructor(token:symbol,original:NewReply,scan:unknown,verified:boolean,thread:ThreadInfo|null,file:NewReplyFileObservation|null,alreadyVerified:boolean){
  if(token!==TOKEN)throw new TypeError('Expected owned new reply inspection');
  this.#original=original;this.#scan=scan;this.#verified=verified;this.#thread=thread;this.#file=file;this.#alreadyVerified=alreadyVerified;Object.freeze(this);
 }
 captured():Readonly<{original:NewReply;scan:unknown;verified:boolean}>{return Object.freeze({original:this.#original,scan:this.#scan,verified:this.#verified});}
 /** Point-in-time mapping/file recheck. Not an atomic lease on another producer.
  * Existing verified durable state follows the source's sticky verification path;
  * store identity/mapping revalidation is still mandatory at checkpoint. */
 async verifyCurrent(signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();if(this.#alreadyVerified)return;
  const id=this.#original.identity,after=await readNewReplyThreadOffThread(id.state_db,id.thread_id,signal);
  if(!sameThread(this.#thread,after))throw new Error('new thread source changed during verification');
  if(this.#file!==null)await this.#file.verifyCurrent(signal);
 }
}
Object.freeze(NewReplyInspection.prototype);
/** Source inspect order with bounded native DB/file/JSON work and explicit v2
 * cursor continuity. No automatic reset/adoption of old generation fingerprints.
 * Growth relies on the producer append-only contract; bounded anchors do not
 * certify untouched history. Consumer must retain original revision and validate
 * mapping again before a durable conditional update. No ACK/output is sent. */
export async function inspectNewReply(input:NewReply,signal?:AbortSignal):Promise<NewReplyInspection>{
 signal?.throwIfAborted();const record=capture(input),id=record.identity;
 if(record.state==='verified')return new NewReplyInspection(TOKEN,record,record.scan,true,null,null,true);
 const before=await readNewReplyThreadOffThread(id.state_db,id.thread_id,signal);
 if(before===null){const result=new NewReplyInspection(TOKEN,record,record.scan,false,null,null,false);await result.verifyCurrent(signal);return result;}
 if(normalizeWorkspacePathPosix(before.cwd)!==normalizeWorkspacePathPosix(id.cwd))throw new Error('new thread persisted in a different project');
 const identity={threadId:id.thread_id,cwd:id.cwd,turnId:record.turnId,promptSha256:id.prompt_sha256},scan=record.scan;let cursor:NewReplyFileCursor;
 if(scan!==null&&typeof scan==='object'&&!Array.isArray(scan)&&Object.keys(scan).length===0)cursor=await beginNewReplyFileCursor(before.rolloutPath,identity,signal);
 else{
  if(own(scan,'format')!==FORMAT||typeof own(scan,'cursor')!=='string')throw new Error('Unsupported new reply checkpoint; legacy cursor adoption requires review');
  cursor=decodeNewReplyFileCursor(own(scan,'cursor') as string);
  if(cursor.anchor.path!==pinNativeRuntimePath(before.rolloutPath)||cursor.identity.threadId!==identity.threadId||cursor.identity.cwd!==identity.cwd||cursor.identity.turnId!==identity.turnId||cursor.identity.promptSha256!==identity.promptSha256)throw new Error('new reply cursor original request or source changed');
 }
 const file=await observeNewReplyFile(cursor,undefined,signal),next=Object.freeze({format:FORMAT,cursor:encodeNewReplyFileCursor(file.cursor)}),result=new NewReplyInspection(TOKEN,record,next,file.cursor.state.matched,before,file,false);
 await result.verifyCurrent(signal);return result;
}
