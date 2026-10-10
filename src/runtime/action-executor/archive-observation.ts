import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {cloneAppRequest} from '../../app-server/requests.ts';
import {rustTrim,serdeField} from '../../app-server/value.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serdeValueEqual} from '../../core/serde-value-equal.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {planPrefix} from '../prefix-plan.ts';
import {ActionIntegerRangeError,InvalidActionRequestError} from './errors.ts';
export interface ArchiveActor {readonly channelId:bigint;readonly userId:bigint;readonly discordMessageId:bigint|null;}
const sourceKinds=['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'];
/** Read-only discovery before any archive mutation. Every page is pinned to the
 * same resident generation; missing/repeated pagination never yields partial scope. */
export async function archiveDescendants(server:PortableResidentLifecycle,root:string,generation:bigint,signal?:AbortSignal):Promise<readonly string[]>{
 requireDiscordText(root);if(typeof generation!=='bigint'||generation<0n||generation>=1n<<64n)throw new TypeError('Expected u64 generation');
 const ids=new Set<string>(),cursors=new Set<string>();let cursor:string|null=null;
 for(let page=0;page<=10;page++){
  signal?.throwIfAborted();const value=cloneOwnedSerdeValue(await PortableResidentLifecycle.prototype.execute.call(server,cloneAppRequest({method:'thread/list',params:{ancestorThreadId:root,archived:false,limit:100n,cursor,sourceKinds},timeoutMs:8000}),generation,signal));signal?.throwIfAborted();
  const data=serdeField(value,'data');if(!Array.isArray(data))throw new InvalidActionRequestError('archive descendant inventory is missing or invalid');
  for(const thread of data){const id=serdeField(thread,'id');if(typeof id!=='string'||id===''||rustTrim(id)!==id)throw new InvalidActionRequestError('archive descendant has no exact identity');
   if(id===root||ids.has(id)||ids.size===100)throw new InvalidActionRequestError('archive scope is repeated, inconsistent, or exceeds 100 descendants; no archive was sent');ids.add(id);
  }
  const next=serdeField(value,'nextCursor');if(next===null)return Object.freeze([...ids].sort((a,b)=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8'))));
  if(typeof next!=='string'||next===''||cursors.has(next))throw new InvalidActionRequestError('archive descendant pagination is missing or repeated; no archive was sent');cursors.add(next);cursor=next;
 }
 throw new InvalidActionRequestError('archive descendant pagination exceeded its bound; no archive was sent');
}
function u64(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<0n||value>=1n<<64n)throw new TypeError('Expected u64 archive actor');}
function i64(value:bigint):bigint{if(value>=1n<<63n)throw new ActionIntegerRangeError();return value;}
const invalid=()=>new InvalidActionRequestError('archive cannot verify its original command/user/channel envelope; no archive was sent');
/** Observation only: a returned ingress ID is not a durable reservation or a
 * transferable authorization. Archive coordinator must recheck under custody. */
export async function archiveOwnRequest(path:string,input:ArchiveActor,reference:string|null,signal?:AbortSignal):Promise<string|null>{
 requireDiscordText(path);if(reference!==null)requireDiscordText(reference);const actor=cloneOwnedSerdeValue(input) as ArchiveActor;
 u64(actor.channelId);u64(actor.userId);if(actor.discordMessageId!==null)u64(actor.discordMessageId);signal?.throwIfAborted();
 if(actor.discordMessageId===null)return null;
 const event=i64(actor.discordMessageId),row=await state.ingressByOrigin(path,event);signal?.throwIfAborted();if(row===null)throw invalid();
 const content=serdeField(row.payload,'content'),trimmed=typeof content==='string'?rustTrim(content):'';let parsed:unknown;
 if(trimmed.startsWith('!')){try{parsed=planPrefix(trimmed.slice(1));}catch{parsed=undefined;}}
 const command={Archive:{reference}};
 if(row.kind!=='message'||row.sourceMessageId!==event||row.channelId!==i64(actor.channelId)||row.ownerUserId!==i64(actor.userId)||row.state!=='executing'||row.phase!=='processing'||row.ownerId!==null||serdeField(row.payload,'version')!==1n||!serdeValueEqual(serdeField(row.payload,'plan'),{Execute:command})||!serdeValueEqual(parsed,command))throw invalid();
 return row.ingressId;
}
