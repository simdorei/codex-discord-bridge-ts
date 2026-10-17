import {decodeNewThreadOrigin,directNewProjectLookup,type NewProjectLookup} from './new-project-cwd.ts';
export {decodeNewThreadOrigin} from './new-project-cwd.ts';
import {newStateFunction,newStatePromise} from './new-state-call.ts';
import {types} from 'node:util';
import {normalizeWorkspacePath} from '../../codex-state/thread-reference.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import type {StoredIngress} from '../../store/ingress-read.ts';
import type {NewThreadOrigin} from '../../store/new-thread-origin.ts';
import {NewThreadJournal} from './new-journal.ts';
import {InvalidActionRequestError,ActionIntegerRangeError} from './errors.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
/** POSIX original project resolution. The store transaction rechecks every
 * captured mapping before writing new_creation; no thread/start is sent here. */
export class NewThreadProject {
 readonly #lookup:NewProjectLookup;
 readonly #record:typeof state.recordIngressNewCreation;
 readonly #database:string;readonly #statePath:string;readonly #journal:NewThreadJournal;readonly #mirrored:boolean;readonly #now:()=>number;
 constructor(database:string,statePath:string,journal:NewThreadJournal,mirrored:boolean,now:()=>number=systemNow,port:Pick<typeof state,'recordIngressNewCreation'>=state,lookup:NewProjectLookup=directNewProjectLookup){requireDiscordText(database);requireDiscordText(statePath);NewThreadJournal.prototype.requireDatabase.call(journal,database);if(typeof now!=='function'||types.isProxy(now)||types.isAsyncFunction(now)||types.isGeneratorFunction(now))throw new TypeError('Expected synchronous project clock');if(typeof mirrored!=='boolean')throw new TypeError('Expected mirror mode');this.#lookup=newStateFunction({lookup},'lookup');this.#record=newStateFunction(port,'recordIngressNewCreation');this.#database=database;this.#statePath=statePath;this.#journal=journal;this.#mirrored=mirrored;this.#now=now;Object.freeze(this);}
 async freeze(ingress:StoredIngress,channel:bigint,generation:bigint,signal?:AbortSignal):Promise<string|null>{
  NewThreadJournal.prototype.requireOriginalRecord.call(this.#journal,ingress);

  let origin:NewThreadOrigin;try{origin=decodeNewThreadOrigin(gatewayOwnField(ingress.payload,'new_origin'));}catch(error){throw await this.#journal.hold(ingress,new InvalidActionRequestError('new origin snapshot is missing or invalid'),true);}
  let cwd:string|null;try{cwd=await newStatePromise(Reflect.apply(this.#lookup,undefined,[this.#statePath,origin,signal]));}catch(error){throw await this.#journal.hold(ingress,error,true);}
  if(cwd!==null)for(const key of [origin.mapped_project,origin.project,origin.parent_project])if(key!==null&&key!=='codex:chats'&&!key.startsWith('projectless:')&&normalizeWorkspacePath(key)!==normalizeWorkspacePath(cwd))throw await this.#journal.hold(ingress,new InvalidActionRequestError('Codex working directory differs from the frozen Discord project; no thread/start permitted'),true);
  if(this.#mirrored&&cwd===null)throw await this.#journal.hold(ingress,new InvalidActionRequestError('new request has no verified originating project'),true);
  try{if(typeof channel!=='bigint'||channel<0n||channel>=(1n<<63n))throw new ActionIntegerRangeError();await newStatePromise(Reflect.apply(this.#record,undefined,[this.#database,ingress.ingressId,generation,cwd,channel,readCustodyTimestamp(this.#now)]));}catch(error){throw await this.#journal.hold(ingress,error,true);}
  return cwd;
 }
}
Object.freeze(NewThreadProject.prototype);
