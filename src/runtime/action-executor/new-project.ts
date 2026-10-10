import {types} from 'node:util';
import {statSync} from 'node:fs';
import {CodexThreadStore} from '../../codex-state/store.ts';
import {normalizeWorkspacePathPosix,stripWindowsExtendedPrefix} from '../../codex-state/thread-reference.ts';
import {parseSerdeStruct,type StructShape,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import type {StoredIngress} from '../../store/ingress-read.ts';
import type {NewThreadOrigin} from '../../store/new-thread-origin.ts';
import {NewThreadJournal} from './new-journal.ts';
import {InvalidActionRequestError,ActionIntegerRangeError} from './errors.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
const byte:StructFieldDecoder=(_r,_d,c)=>{const v=c.decode('u64') as bigint;if(v>255n)throw new SyntaxError('Expected u8 origin version');return v;};
const optionalI64:StructFieldDecoder=(_r,_d,c)=>c.value()===null?null:c.decode('i64');
const SHAPE:StructShape={fields:[['version',byte],['channel','i64'],['target','string?'],['mapped_project','string?'],['parent_channel',optionalI64],['project','string?'],['parent_project','string?'],['chat_targets','string[]']],mapDefaults:{parent_channel:null}};
export function decodeNewThreadOrigin(value:unknown):NewThreadOrigin{return parseSerdeStruct(serializeSerdeValue(value),SHAPE) as unknown as NewThreadOrigin;}
function checkedCwd(input:string):string {
 const cwd=stripWindowsExtendedPrefix(input);let directory=false;try{directory=statSync(cwd).isDirectory();}catch{}
 if(!directory)throw new InvalidActionRequestError(`project directory is unavailable: ${cwd}`);return cwd;
}
/** POSIX original project resolution. The store transaction rechecks every
 * captured mapping before writing new_creation; no thread/start is sent here. */
export class NewThreadProject {
 readonly #database:string;readonly #statePath:string;readonly #journal:NewThreadJournal;readonly #mirrored:boolean;readonly #now:()=>number;
 constructor(database:string,statePath:string,journal:NewThreadJournal,mirrored:boolean,now:()=>number=systemNow){requireDiscordText(database);requireDiscordText(statePath);NewThreadJournal.prototype.requireDatabase.call(journal,database);if(typeof now!=='function'||types.isProxy(now)||types.isAsyncFunction(now)||types.isGeneratorFunction(now))throw new TypeError('Expected synchronous project clock');if(typeof mirrored!=='boolean')throw new TypeError('Expected mirror mode');this.#database=database;this.#statePath=statePath;this.#journal=journal;this.#mirrored=mirrored;this.#now=now;Object.freeze(this);}
 #cwd(origin:NewThreadOrigin):string|null {
  if(origin.target!==null){const thread=CodexThreadStore.open(this.#statePath).loadThread(origin.target,false);if(thread===null)throw new InvalidActionRequestError(`cannot resolve project of mapped thread ${origin.target}`);return checkedCwd(thread.cwd);}
  if(origin.project!==null){if(origin.project==='codex:chats'||origin.project.startsWith('projectless:')){const thread=CodexThreadStore.open(this.#statePath).loadRecentThreads(0n).find(t=>origin.chat_targets.includes(t.id));if(thread===undefined)throw new InvalidActionRequestError('chat project has no known working directory');return checkedCwd(thread.cwd);}return checkedCwd(origin.project);}
  return null;
 }
 async freeze(ingress:StoredIngress,channel:bigint,generation:bigint):Promise<string|null>{
  NewThreadJournal.prototype.requireOriginalRecord.call(this.#journal,ingress);
  if(process.platform==='win32')throw new Error('Windows new project resolution is not yet qualified');
  let origin:NewThreadOrigin;try{origin=decodeNewThreadOrigin(gatewayOwnField(ingress.payload,'new_origin'));}catch(error){throw await this.#journal.hold(ingress,new InvalidActionRequestError('new origin snapshot is missing or invalid'),true);}
  let cwd:string|null;try{cwd=this.#cwd(origin);}catch(error){throw await this.#journal.hold(ingress,error,true);}
  if(cwd!==null)for(const key of [origin.mapped_project,origin.project,origin.parent_project])if(key!==null&&key!=='codex:chats'&&!key.startsWith('projectless:')&&normalizeWorkspacePathPosix(key)!==normalizeWorkspacePathPosix(cwd))throw await this.#journal.hold(ingress,new InvalidActionRequestError('Codex working directory differs from the frozen Discord project; no thread/start permitted'),true);
  if(this.#mirrored&&cwd===null)throw await this.#journal.hold(ingress,new InvalidActionRequestError('new request has no verified originating project'),true);
  try{if(typeof channel!=='bigint'||channel<0n||channel>=(1n<<63n))throw new ActionIntegerRangeError();await state.recordIngressNewCreation(this.#database,ingress.ingressId,generation,cwd,channel,readCustodyTimestamp(this.#now));}catch(error){throw await this.#journal.hold(ingress,error,true);}
  return cwd;
 }
}
Object.freeze(NewThreadProject.prototype);
