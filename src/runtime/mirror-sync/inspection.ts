import {types} from 'node:util';
import {TargetLocks} from '../../core/keyed-locks.ts';
import {OwnedWorkerSlot} from '../owned-worker-slot.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {serdeField} from '../../app-server/value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import type {MirrorInspectionLocal} from './inspection-local.ts';
import type {NewMirrorTransport,MirrorChannel} from './new-mirror-link.ts';
const slot=new OwnedWorkerSlot();
export function joinMirrorInspectionReader():Promise<void>{return slot.join();}
export function mirrorInspectionReaderBusy():boolean{return slot.busy;}
const invalid=(s:string)=>new Error(`mirror sync cannot continue: ${s}`);
function id(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<=0n||value>=1n<<64n)throw new TypeError('Expected nonzero u64 Discord ID');}
function channel(input:MirrorChannel):MirrorChannel{const c=cloneOwnedSerdeValue(input) as MirrorChannel;id(c.id);if(c.guildId!==null)id(c.guildId);if(c.parentId!==null)id(c.parentId);requireDiscordText(c.name);if(typeof c.kind!=='bigint'||c.kind<0n||c.kind>255n||typeof c.archived!=='boolean')throw new TypeError('Malformed mirror channel');return c;}
/** Read-only full inventory. limit truncates display only, never the checked
 * scope. One global local-reader worker with zero queue; 4 MiB serialized transfer
 * ceiling fails the whole inspection, not a truncated healthy result. This is not
 * a bound on SQLite/V8 allocation inside the worker or a global runtime heap cap. */
export class MirrorInspector{
 readonly #codex:string;readonly #mirror:string;readonly #guild:bigint|null;readonly #locks:TargetLocks;readonly #remote:Pick<NewMirrorTransport,'channel'>;readonly #read:NewMirrorTransport['channel'];readonly #total:number;readonly #lock:number;
 constructor(codex:string,mirror:string,remote:Pick<NewMirrorTransport,'channel'>,locks:TargetLocks,guild:bigint|null=null,budgets={totalMs:120000,lockMs:10000}){
  requireDiscordText(codex);requireDiscordText(mirror);if(guild!==null)id(guild);if(remote===null||typeof remote!=='object'||types.isProxy(remote))throw new TypeError('Expected read-only mirror transport');const d=Object.getOwnPropertyDescriptor(remote,'channel');if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function'||types.isProxy(d.value)||types.isGeneratorFunction(d.value))throw new TypeError('Expected owned channel reader');
  for(const n of [budgets.totalMs,budgets.lockMs])if(!Number.isSafeInteger(n)||n<=0||n>2147483647)throw new RangeError('Expected finite mirror deadline');this.#codex=codex;this.#mirror=mirror;this.#remote=remote;this.#read=d.value;this.#locks=locks;this.#guild=guild;this.#total=budgets.totalMs;this.#lock=budgets.lockMs;Object.freeze(this);
 }
 async inspect(origin:bigint,limit:bigint|null,list:boolean,external?:AbortSignal):Promise<string>{
  id(origin);if(limit!==null&&(typeof limit!=='bigint'||limit<0n||limit>0xffffffffn)||typeof list!=='boolean')throw new TypeError('Expected inspection display options');external?.throwIfAborted();
  const budget=new AbortController(),waiting=new AbortController(),timer=setTimeout(()=>budget.abort(invalid('phase=operation; operation=inspect; total deadline including lock wait; read-only inspection incomplete; no mutations dispatched')),this.#total),lockTimer=setTimeout(()=>waiting.abort(invalid('phase=lock_wait; operation=inspect; not started; current lock owner was not cancelled')),this.#lock),signal=external?AbortSignal.any([external,budget.signal]):budget.signal;let lease;
  try{
   lease=await this.#locks.acquire('mirror-sync-operation',AbortSignal.any([signal,waiting.signal]));clearTimeout(lockTimer);signal.throwIfAborted();
   const raw=await slot.run(new URL('./inspection-worker.ts',import.meta.url),{operation:'inventory',codex:this.#codex,mirror:this.#mirror},this.#total,signal);signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,4*1024*1024+4096)===null)throw invalid('invalid or over-budget local inspection response');const response=cloneOwnedSerdeValue(raw);if(serdeField(response,'ok')!==true){const message=serdeField(response,'message');throw invalid(typeof message==='string'?message:'local inspection failed');}
   const s=serdeField(response,'value') as MirrorInspectionLocal;let guild=this.#guild;if(guild===null){guild=(await this.#channel(origin,signal))?.guildId??null;if(guild===null)throw invalid('cannot resolve inspection guild');}
   const rolloutRaw=await slot.run(new URL('./inspection-worker.ts',import.meta.url),{operation:'rollouts',rollouts:s.rollouts},this.#total,signal);signal.throwIfAborted();
   if(boundedSerdeByteCount(rolloutRaw,4*1024*1024+4096)===null)throw invalid('invalid or over-budget rollout response');const rolloutResponse=cloneOwnedSerdeValue(rolloutRaw);if(serdeField(rolloutResponse,'ok')!==true){const message=serdeField(rolloutResponse,'message');throw invalid(typeof message==='string'?message:'rollout inspection failed');}
   const missingRollouts=serdeField(rolloutResponse,'value');if(!Array.isArray(missingRollouts)||missingRollouts.some(value=>typeof value!=='string'))throw invalid('invalid rollout result');
   const details=[...s.details];let detailBytes=details.reduce((n,line)=>n+Buffer.byteLength(line,'utf8')+1,0);const add=(line:string)=>{detailBytes+=Buffer.byteLength(line,'utf8')+1;if(detailBytes>4*1024*1024)throw invalid('inspection detail output exceeds 4 MiB budget; inspection incomplete');details.push(line);};for(const missing of missingRollouts)add(`missing_rollout | ${missing}`);let remoteErrors=0;
   for(const parent of s.parents){const result=await this.#check(parent,guild,0n,null,signal);if(result!=='ok'){remoteErrors++;add(`project_channel ${parent} | ${result}`);}}
   for(const {row,stale,duplicate} of s.mappings){const result=await this.#check(row.discordThreadId,guild,11n,row.discordChannelId>0n?row.discordChannelId:null,signal),issues:string[]=[];if(stale)issues.push('stale_mapping');if(duplicate)issues.push('duplicate_room');if(row.discordChannelId<=0n)issues.push('invalid_parent');if(result!=='ok'){remoteErrors++;issues.push(result);}if(list||issues.length)add(`${row.codexThreadId} | room=${row.discordThreadId} | title=${row.threadTitle.replace(/[\r\n]/gu,' ')} | ${issues.length?issues.join('; '):'ok'}`);}
   signal.throwIfAborted();const status=s.missing===0&&s.projectsOk&&s.duplicates===0&&s.stale===0&&missingRollouts.length===0&&remoteErrors===0?'ok':'issues_found',total=details.length,shown=limit===null?details:details.slice(0,Number(limit));
   return `Discord mirror ${list?'list':'check'} (read-only)\nscope: configured local Codex DB; interactive user roots + mapped active threads; writer ownership not verified\nstatus: ${status}\nexpected_threads: ${s.expected}\ntargets: ${s.mappings.length}\nmissing_mapping: ${s.missing}\nduplicate_rooms: ${s.duplicates}\nstale_mappings: ${s.stale}\nmissing_rollouts: ${missingRollouts.length}\nremote_errors: ${remoteErrors}\n${s.projectSummary}\ndetails: ${shown.length}/${total} (limit affects display only)\n${shown.join('\n')}`;
  }finally{clearTimeout(timer);clearTimeout(lockTimer);if(lease){const held=lease;if(slot.busy)void slot.join().then(()=>held.release());else held.release();}}
 }
 async #channel(value:bigint,signal:AbortSignal):Promise<MirrorChannel|null>{signal.throwIfAborted();const pending=Reflect.apply(this.#read,this.#remote,[value,signal]);if(!types.isPromise(pending))throw new TypeError('Expected native channel Promise');const result=await pending as MirrorChannel|null;signal.throwIfAborted();if(result===null)return null;const c=channel(result);if(c.id!==value)throw invalid(`channel response identity differs for ${value}`);return c;}
 async #check(value:bigint,guild:bigint,kind:bigint,parent:bigint|null,signal:AbortSignal):Promise<string>{
  if(value<=0n)return invalid('invalid stored Discord id').message;
  let c:MirrorChannel|null;try{c=await this.#channel(value,signal);}catch(error){signal.throwIfAborted();return `access_error: ${passiveErrorText(error,'remote read failed')}`;}
  if(c===null)return 'missing_room';if(c.guildId!==guild||c.kind!==kind||(parent!==null&&c.parentId!==parent))return invalid(`stored channel ${c.id} has the wrong guild, kind, or parent`).message;return c.archived?'discord_room_archived':'ok';
 }
}
Object.freeze(MirrorInspector.prototype);
