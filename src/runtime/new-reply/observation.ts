import {createHash} from 'node:crypto';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {serdeField} from '../../app-server/value.ts';
import {normalizeWorkspacePath} from '../../codex-state/thread-reference.ts';
export interface NewReplyObservationIdentity{readonly threadId:string;readonly cwd:string;readonly turnId:string|null;readonly promptSha256:string;}
export interface NewReplyObservationState{readonly sessionSeen:boolean;readonly turn:string|null;readonly matched:boolean;}
const MAX_EVENT_BYTES=262144,MAX_ID_BYTES=16384;
function text(value:unknown):asserts value is string{requireDiscordText(value);if(Buffer.byteLength(value)>MAX_ID_BYTES)throw new RangeError('New reply identity exceeds bounded text budget');}
function captureIdentity(input:NewReplyObservationIdentity):NewReplyObservationIdentity{
 const threadId=own(input,'threadId'),cwd=own(input,'cwd'),turnId=own(input,'turnId'),promptSha256=own(input,'promptSha256');for(const s of [threadId,cwd,promptSha256])text(s);if(turnId!==null)text(turnId);
 return Object.freeze({threadId:threadId as string,cwd:cwd as string,turnId,promptSha256:promptSha256 as string});
}
function captureState(input:NewReplyObservationState):NewReplyObservationState{const sessionSeen=own(input,'sessionSeen'),turn=own(input,'turn'),matched=own(input,'matched');if(typeof sessionSeen!=='boolean'||typeof matched!=='boolean')throw new TypeError('Invalid new reply observation state');if(turn!==null)text(turn);return Object.freeze({sessionSeen,turn,matched});}
/** Pure source observe() recognition, for use inside a bounded native scan.
 * State has no file authority: caller must bind identity, file continuity and
 * complete-record cursor before persisting or releasing first-reply holds.
 * POSIX lexical workspace profile only; Windows qualification is separate.
 * Existing source fingerprint/reset policy is intentionally not implemented. */
export class NewReplyObserver{
 readonly #identity:NewReplyObservationIdentity;#state:NewReplyObservationState;
 constructor(identity:NewReplyObservationIdentity,state:NewReplyObservationState={sessionSeen:false,turn:null,matched:false}){this.#identity=captureIdentity(identity);this.#state=captureState(state);}
 snapshot():NewReplyObservationState{return this.#state;}
 observe(input:unknown):boolean{
  if(this.#state.matched)return true;
  if(boundedSerdeByteCount(input,MAX_EVENT_BYTES)===null)throw new RangeError('New reply event exceeds bounded decoded JSON profile');
  const event=cloneOwnedSerdeValue(input),payload=serdeField(event,'payload');if(payload===undefined)return false;
  const type=serdeField(event,'type'),kind=serdeField(payload,'type'),id=this.#identity;let {sessionSeen,turn}=this.#state;
  if(type==='session_meta'){
   const cwd=serdeField(payload,'cwd');if(serdeField(payload,'id')!==id.threadId||typeof cwd!=='string'||normalizeWorkspacePath(cwd)!==normalizeWorkspacePath(id.cwd))throw new Error('new rollout thread/project identity mismatch');sessionSeen=true;
  }else if(type==='turn_context'||type==='event_msg'&&kind==='task_started'){const value=serdeField(payload,'turn_id');if(typeof value==='string'){text(value);turn=value;}else turn=null;}
  else if(type==='event_msg'&&kind==='task_complete')turn=null;
  let matched=false;
  if(sessionSeen&&turn!==null&&turn===id.turnId){
   let content:string|undefined;
   if(type==='event_msg'&&kind==='user_message'){const value=serdeField(payload,'message');if(typeof value==='string')content=value;}
   else if(type==='response_item'&&serdeField(payload,'role')==='user'){const parts=serdeField(payload,'content');if(Array.isArray(parts))content=parts.map(p=>serdeField(p,'text')).filter((p):p is string=>typeof p==='string').join('');}
   matched=content!==undefined&&createHash('sha256').update(content,'utf8').digest('hex')===id.promptSha256;
  }
  this.#state=Object.freeze({sessionSeen,turn,matched});return matched;
 }
}
Object.freeze(NewReplyObserver.prototype);
