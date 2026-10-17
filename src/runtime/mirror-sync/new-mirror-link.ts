import {types} from 'node:util';
import {TargetLocks} from '../../core/keyed-locks.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {normalizeWorkspacePathPosix} from '../../codex-state/thread-reference.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import type {NewMirrorLink} from '../action-executor/new-executor.ts';
import {readCustodyTimestamp} from '../discord-dispatch/staged-custody.ts';
import {now as systemNow} from '../../store/queue-attach-goal.ts';
export interface MirrorChannel {readonly id:bigint;readonly guildId:bigint|null;readonly parentId:bigint|null;readonly kind:bigint;readonly name:string;readonly archived:boolean}
export interface NewMirrorTransport {
 readonly channel:(id:bigint,signal:AbortSignal)=>Promise<MirrorChannel|null>;
 readonly createThread:(guild:bigint,parent:bigint,name:string,signal:AbortSignal)=>Promise<MirrorChannel>;
 readonly updateThread:(channel:MirrorChannel,name:string,signal:AbortSignal)=>Promise<void>;
}
export class NewMirrorLinkError extends Error {constructor(detail:string){super(`mirror sync cannot continue: ${detail}`);this.name='NewMirrorLinkError';}}
const invalid=(message:string):never=>{throw new NewMirrorLinkError(message);};
function id(value:unknown):bigint {if(typeof value!=='bigint'||value<=0n||value>=1n<<64n)throw new TypeError('Expected nonzero u64 Discord identity');return value;}
function dbId(value:bigint):bigint {id(value);if(value>=1n<<63n)invalid('Discord id exceeds database range');return value;}
function snapshot(input:MirrorChannel):MirrorChannel {const c=cloneOwnedSerdeValue(input) as MirrorChannel;id(c.id);if(c.guildId!==null)id(c.guildId);if(c.parentId!==null)id(c.parentId);if(typeof c.kind!=='bigint'||c.kind<0n||c.kind>255n||typeof c.archived!=='boolean')throw new TypeError('Invalid mirror channel shape');requireDiscordText(c.name);return Object.freeze(c);}
function validate(c:MirrorChannel,guild:bigint,parent:bigint):void {if(c.guildId!==guild||c.kind!==11n||c.parentId!==parent)invalid(`stored channel ${c.id} has the wrong guild, kind, or parent`);}
function method<T>(input:NewMirrorTransport,key:keyof NewMirrorTransport):T {const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function'||types.isProxy(d.value))throw new TypeError('Expected owned mirror transport function');return d.value as T;}
async function native<T>(value:Promise<T>):Promise<T> {if(!types.isPromise(value))throw new TypeError('Expected native mirror transport Promise');return value;}
export function newMirrorThreadName(prompt:string,thread:string):string {requireDiscordText(prompt);requireDiscordText(thread);const name=prompt.split(/\p{White_Space}+/u).filter(Boolean).join(' ');if(name==='')return `codex-${[...thread].slice(0,8).join('')}`;let result='';for(const c of name){if(result.length+c.length>90)break;result+=c;}return result;}
/** Narrow new-thread linker, never global sync/cleanup. All mirror operations must
 * share this lock registry. Transport must cancel cooperatively; lock is retained
 * until work settles, including after timeout. Concrete HTTP adapter is separate. */
export class NewThreadMirrorLink implements NewMirrorLink {
 readonly linkNewThread:NewMirrorLink['linkNewThread'];
 constructor(database:string,remote:NewMirrorTransport,locks:TargetLocks,guild:bigint|null=null,now:()=>number=systemNow){
  requireDiscordText(database);if(guild!==null)id(guild);if(process.platform==='win32')throw new Error('Windows mirror workspace normalization not yet qualified');if(typeof remote!=='object'||remote===null||types.isProxy(remote))throw new TypeError('Expected mirror transport');if(typeof now!=='function'||types.isProxy(now)||types.isAsyncFunction(now)||types.isGeneratorFunction(now))throw new TypeError('Expected synchronous timestamp');
  const read=method<NewMirrorTransport['channel']>(remote,'channel'),create=method<NewMirrorTransport['createThread']>(remote,'createThread'),update=method<NewMirrorTransport['updateThread']>(remote,'updateThread');
  const readChannel=async(value:bigint,signal:AbortSignal)=>{signal.throwIfAborted();const result=await native<MirrorChannel|null>(Reflect.apply(read,remote,[value,signal]));signal.throwIfAborted();return result===null?null:snapshot(result);};
  const work=async(originId:bigint,thread:string,prompt:string,cwd:string|null,signal:AbortSignal):Promise<bigint>=>{
   const origin=await readChannel(originId,signal)??invalid('new-thread origin channel is unavailable');if(origin.id!==originId)invalid('origin channel response identity changed');const actualGuild=origin.guildId??invalid('new-thread origin has no guild');if(guild!==null&&guild!==actualGuild)invalid('new-thread origin has the wrong guild');
   const parent=[10n,11n,12n].includes(origin.kind)?origin.parentId??invalid('origin thread has no project parent'):origin.kind===0n?origin.id:invalid('new requires a project text channel or its thread');
   const project=await state.mirrorProjectForChannel(database,dbId(parent));signal.throwIfAborted();const projectKey=project?.[0]??null,key=projectKey??(cwd===null?invalid('new-thread project identity is unavailable'):normalizeWorkspacePathPosix(cwd));
   if(key!=='codex:chats'&&!key.startsWith('projectless:')&&cwd!==null&&normalizeWorkspacePathPosix(cwd)!==normalizeWorkspacePathPosix(key))invalid('new-thread project changed before room creation');
   const name=newMirrorThreadName(prompt,thread),expected=await state.mirrorThreadChannels(database,thread);signal.throwIfAborted();const scope={thread,guild:dbId(actualGuild),parent:dbId(parent),expected};const confirmed=await state.confirmedMirrorCreation(database,scope);signal.throwIfAborted();let channel:MirrorChannel|null=null;
   if(confirmed!==null){channel=await readChannel(id(confirmed),signal)??invalid(`confirmed created room ${confirmed} is unavailable; creation will not be repeated`);if(channel.id!==confirmed)invalid('created room response identity changed');validate(channel,actualGuild,parent);}
   else if(expected!==null){channel=await readChannel(id(expected[1]),signal);if(channel!==null&&channel.id!==expected[1])invalid('stored room response identity changed');}
   if(channel!==null){validate(channel,actualGuild,parent);if(channel.name!==name||channel.archived){await native(Reflect.apply(update,remote,[channel,name,signal]));signal.throwIfAborted();}}
   else {const token=await state.beginMirrorCreation(database,scope);signal.throwIfAborted();channel=snapshot(await native<MirrorChannel>(Reflect.apply(create,remote,[actualGuild,parent,name,signal])));validate(channel,actualGuild,parent);await state.confirmMirrorCreation(database,scope,token,dbId(channel.id));signal.throwIfAborted();}
   await state.commitNewThreadSync(database,{threadId:thread,projectKey:key,title:name,parentId:dbId(parent),channelId:dbId(channel.id),now:readCustodyTimestamp(now)},expected,projectKey);return channel.id;
  };
  this.linkNewThread=async(origin,thread,prompt,cwd,external)=>{
   id(origin);requireDiscordText(thread);requireDiscordText(prompt);if(cwd!==null)requireDiscordText(cwd);external?.throwIfAborted();const budget=new AbortController(),waiting=new AbortController();
   const operationError=new NewMirrorLinkError('phase=operation; operation=new_thread; deadline=120s total including lock wait; earlier changes may have completed; in-flight remote outcome unconfirmed; no automatic retry issued');
   const lockError=new NewMirrorLinkError('phase=lock_wait; operation=new_thread; deadline=10s; not started; no requests dispatched by this call; current lock owner was not cancelled');
   const operationTimer=setTimeout(()=>budget.abort(operationError),120000),lockTimer=setTimeout(()=>waiting.abort(lockError),10000),signal=external===undefined?budget.signal:AbortSignal.any([budget.signal,external]);let lease;
   try{lease=await locks.acquire('mirror-sync-operation',AbortSignal.any([signal,waiting.signal]));clearTimeout(lockTimer);signal.throwIfAborted();return await work(origin,thread,prompt,cwd,signal);}finally{clearTimeout(lockTimer);clearTimeout(operationTimer);lease?.release();}
  };Object.freeze(this);
 }
}
Object.freeze(NewThreadMirrorLink.prototype);
