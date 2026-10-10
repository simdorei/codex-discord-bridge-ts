import {types} from 'node:util';
export const HISTORY_POLL_PAGE_LIMIT=10;
export interface HistoryWatermark {readonly micros:bigint;readonly messageId:bigint}
export type HistoryPollPhase='Prime'|'Reprime'|'Incremental';
export type HistoryPollItem<T>={readonly kind:'Ignore'}|{readonly kind:'Candidate';readonly value:T};
export interface HistoryBatchItem<T>{readonly watermark:HistoryWatermark|null;readonly item:HistoryPollItem<T>}
export type HistoryItemDecision<T>={readonly kind:'NoClaim'}|{readonly kind:'ClaimAndDiscard'|'ClaimAndProcess';readonly value:T};
declare const cycleBrand:unique symbol,commitBrand:unique symbol;
export interface HistoryPollCycleToken {readonly [cycleBrand]:true}
export interface HistoryPollCommitToken {readonly [commitBrand]:true}
export interface HistoryPollProposal<T>{readonly phase:HistoryPollPhase;readonly nextWatermark:HistoryWatermark;readonly itemsOldestFirst:readonly HistoryItemDecision<T>[];readonly commitToken:HistoryPollCommitToken}
type ChannelState={readonly kind:'Priming';readonly phase:'Prime'|'Reprime';readonly boundary:HistoryWatermark;readonly revision:bigint}|{readonly kind:'Active';readonly watermark:HistoryWatermark|null;readonly revision:bigint};
const U64_MAX=(1n<<64n)-1n;
function u64(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<0n||value>U64_MAX)throw new TypeError('Expected u64 history identity');}
function i64(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<-(1n<<63n)||value>=(1n<<63n))throw new TypeError('Expected i64 UTC microseconds');}
function own(value:unknown,key:string):unknown{if(value===null||typeof value!=='object'||types.isProxy(value))throw new TypeError('Expected passive history data');const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,'value'))throw new TypeError('Expected own history data field');return d.value;}
export function historyMessageWatermark(micros:bigint,messageId:bigint):HistoryWatermark|null{i64(micros);u64(messageId);return messageId===0n?null:Object.freeze({micros,messageId});}
function captureWatermark(value:unknown):HistoryWatermark|null{if(value===null)return null;const micros=own(value,'micros'),message=own(value,'messageId');i64(micros);u64(message);if(message===0n)throw new TypeError('Message watermark requires nonzero identity');return Object.freeze({micros,messageId:message});}
export function compareHistoryWatermarks(a:HistoryWatermark,b:HistoryWatermark):number{const am=own(a,'micros'),ai=own(a,'messageId'),bm=own(b,'micros'),bi=own(b,'messageId');i64(am);i64(bm);u64(ai);u64(bi);return am<bm?-1:am>bm?1:ai<bi?-1:ai>bi?1:0;}
export type HistoryPollErrorKind='BatchTooLarge'|'StaleCycle'|'RevisionExhausted'|'ChannelMismatch'|'StaleCommit';
export class HistoryPollError extends Error{
 readonly kind:HistoryPollErrorKind;readonly channel:bigint;readonly actual:number|bigint|undefined;
 constructor(kind:HistoryPollErrorKind,channel:bigint,actual?:number|bigint){const message=kind==='BatchTooLarge'?`Discord history batch has ${actual} items; maximum is ${HISTORY_POLL_PAGE_LIMIT}`:kind==='StaleCycle'?`history poll cycle for channel ${channel} is stale`:kind==='StaleCommit'?`history proposal for channel ${channel} is stale or already committed`:kind==='ChannelMismatch'?`history proposal belongs to channel ${actual}, not ${channel}`:`history state revision exhausted for channel ${channel}`;super(message);this.name='HistoryPollError';this.kind=kind;this.channel=channel;this.actual=actual;Object.freeze(this);}
}
/** Non-durable cursor. begin fixes the prime boundary before fetch; propose has no
 * side effects; commit is legal only after the entire batch disposition succeeds.
 * Opaque tokens additionally bind to this TS state owner. Payload T is borrowed,
 * never inspected here; the downstream adapter must own its executable DTO. */
export class HistoryPollState{
 readonly #channels=new Map<bigint,ChannelState>();#lastRevision=0n;
 readonly #cycles=new WeakMap<object,{channel:bigint;expected:ChannelState}>();
 readonly #commits=new WeakMap<object,{channel:bigint;expected:ChannelState;next:HistoryWatermark}>();
 #next(channel:bigint):bigint{if(this.#lastRevision===U64_MAX)throw new HistoryPollError('RevisionExhausted',channel);return ++this.#lastRevision;}
 begin(channel:bigint,pollStartedAtMicros:bigint):HistoryPollCycleToken{
  u64(channel);i64(pollStartedAtMicros);let current=this.#channels.get(channel);
  if(current===undefined||current.kind==='Active'&&current.watermark===null){current=Object.freeze({kind:'Priming',phase:current===undefined?'Prime':'Reprime',boundary:Object.freeze({micros:pollStartedAtMicros,messageId:0n}),revision:this.#next(channel)});this.#channels.set(channel,current);}
  const token=Object.freeze({}) as HistoryPollCycleToken;this.#cycles.set(token,{channel,expected:current});return token;
 }
 propose<T>(token:HistoryPollCycleToken,newestFirst:readonly HistoryBatchItem<T>[]):HistoryPollProposal<T>{
  if(types.isProxy(newestFirst)||!Array.isArray(newestFirst))throw new TypeError('Expected history batch');
  const cycle=this.#cycles.get(token);if(cycle===undefined)throw new TypeError('Expected this state owner cycle');
  if(newestFirst.length>HISTORY_POLL_PAGE_LIMIT)throw new HistoryPollError('BatchTooLarge',cycle.channel,newestFirst.length);
  const expected=cycle.expected;if(this.#channels.get(cycle.channel)!==expected)throw new HistoryPollError('StaleCycle',cycle.channel);
  const captured:HistoryBatchItem<T>[]=[];let latest:HistoryWatermark|null=null;
  for(let index=0;index<newestFirst.length;index++){const row=own(newestFirst,String(index)),watermark=captureWatermark(own(row,'watermark')),item=own(row,'item'),kind=own(item,'kind');if(kind!=='Ignore'&&kind!=='Candidate')throw new TypeError('Expected history item kind');captured.push({watermark,item:kind==='Ignore'?{kind}:{kind,value:own(item,'value') as T}});if(watermark!==null&&(latest===null||compareHistoryWatermarks(watermark,latest)>0))latest=watermark;}
  const phase:HistoryPollPhase=expected.kind==='Priming'?expected.phase:'Incremental',boundary=expected.kind==='Priming'?expected.boundary:expected.watermark;
  if(boundary===null)throw new TypeError('begin must establish reprime boundary');const next=latest!==null&&compareHistoryWatermarks(latest,boundary)>0?latest:boundary;
  const items:HistoryItemDecision<T>[]=captured.reverse().map(({watermark,item})=>item.kind==='Ignore'||watermark===null?Object.freeze({kind:'NoClaim' as const}):Object.freeze({kind:phase!=='Reprime'&&compareHistoryWatermarks(watermark,boundary)>0?'ClaimAndProcess' as const:'ClaimAndDiscard' as const,value:item.value}));
  const commitToken=Object.freeze({}) as HistoryPollCommitToken;this.#commits.set(commitToken,{channel:cycle.channel,expected,next});return Object.freeze({phase,nextWatermark:next,itemsOldestFirst:Object.freeze(items),commitToken});
 }
 commit(channel:bigint,token:HistoryPollCommitToken):void{
  u64(channel);const value=this.#commits.get(token);if(value===undefined)throw new TypeError('Expected this state owner commit token');if(value.channel!==channel)throw new HistoryPollError('ChannelMismatch',channel,value.channel);if(this.#channels.get(channel)!==value.expected)throw new HistoryPollError('StaleCommit',channel);
  const revision=this.#next(channel);this.#channels.set(channel,Object.freeze({kind:'Active',watermark:value.next,revision}));
 }
 isPrimed(channel:bigint):boolean{u64(channel);return this.#channels.get(channel)?.kind==='Active';}
 get primedCount():number{return [...this.#channels.values()].filter(v=>v.kind==='Active').length;}
 watermark(channel:bigint):HistoryWatermark|null{u64(channel);const s=this.#channels.get(channel);return s?.kind==='Active'?s.watermark:null;}
 /** Caller supplies the latest successfully loaded bounded target set, never an
  * empty fallback after a target lookup failure. Enforce that source precondition. */
 retainChannels(channels:readonly bigint[]):void{
  if(types.isProxy(channels)||!Array.isArray(channels)||channels.length>50)throw new TypeError('Expected at most fifty successfully loaded targets');const retained=new Set<bigint>();for(let i=0;i<channels.length;i++){const id=own(channels,String(i));u64(id);retained.add(id);}for(const id of this.#channels.keys())if(!retained.has(id))this.#channels.delete(id);
 }
}
Object.freeze(HistoryPollState.prototype);
