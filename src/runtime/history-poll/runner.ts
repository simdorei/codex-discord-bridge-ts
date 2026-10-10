import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {HistoryPollState,HistoryPollError,HISTORY_POLL_PAGE_LIMIT,snapshotHistoryBatchItem,compareHistoryWatermarks,historyMessageWatermark,type HistoryBatchItem,type HistoryWatermark,type HistoryPollCycleToken,type HistoryPollPhase,type HistoryPollProposal} from './state.ts';
export type HistoryClaimPurpose='Discard'|'Process';
export type HistoryClaimOutcome<A>={readonly kind:'Lost'}|{readonly kind:'Won';readonly admitted:A};
export interface HistoryPollIo<P,T,A>{
 readonly fetch:(channel:bigint,limit:number,signal?:AbortSignal)=>Promise<readonly P[]>;
 readonly adapt:(payload:P)=>HistoryBatchItem<T>;
 /** Must return only after durable claim has completed. A is a proof value, not
  * an unowned lease; adapter retains native resources until process settles. */
 readonly claim:(item:T,purpose:HistoryClaimPurpose,signal?:AbortSignal)=>Promise<HistoryClaimOutcome<A>>;
 readonly process:(admitted:A,signal?:AbortSignal)=>Promise<void>;
}
export class HistoryPollRunError extends Error{
 readonly stage:'Source'|'Adaptation'|'Claim'|'Process'|'State'|'Commit';readonly source:unknown;
 constructor(stage:HistoryPollRunError['stage'],source:unknown){super(`history ${stage.toLowerCase()} failed`,{cause:source});this.name='HistoryPollRunError';this.stage=stage;this.source=source;Object.freeze(this);}
}
export interface HistoryPollOutcome{readonly phase:HistoryPollPhase;readonly fetched:number;readonly noClaim:number;readonly claimAttempted:number;readonly claimWon:number;readonly discarded:number;readonly processed:number}
export interface HistoryGapOutcome{readonly coverage:'Reached'|'Incomplete';readonly fetched:number;readonly noClaim:number;readonly claimAttempted:number;readonly claimWon:number;readonly processed:number}
function capture<P,T,A>(io:HistoryPollIo<P,T,A>):HistoryPollIo<P,T,A>{const out={} as Record<string,Function>;for(const key of ['fetch','adapt','claim','process']){const fn=own(io,key);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn)||key==='adapt'&&types.isAsyncFunction(fn))throw new TypeError('Expected owned history IO methods');out[key]=fn.bind(io);}return Object.freeze(out) as unknown as HistoryPollIo<P,T,A>;}
async function step<T>(stage:HistoryPollRunError['stage'],signal:AbortSignal|undefined,run:()=>Promise<T>):Promise<T>{signal?.throwIfAborted();try{const pending=run();if(!types.isPromise(pending))throw new TypeError('Expected native history IO Promise');const result=await pending;signal?.throwIfAborted();return result;}catch(error){if(signal?.aborted&&error===signal.reason)throw error;throw new HistoryPollRunError(stage,error);}}
async function batch<P,T,A>(channel:bigint,io:HistoryPollIo<P,T,A>,signal?:AbortSignal):Promise<HistoryBatchItem<T>[]>{
 const payloads=await step('Source',signal,()=>io.fetch(channel,HISTORY_POLL_PAGE_LIMIT,signal));if(types.isProxy(payloads)||!Array.isArray(payloads))throw new HistoryPollRunError('Source',new TypeError('Expected complete history array'));if(payloads.length>HISTORY_POLL_PAGE_LIMIT)throw new HistoryPollRunError('State',new HistoryPollError('BatchTooLarge',channel,payloads.length));
 const result:HistoryBatchItem<T>[]=[];for(let i=0;i<payloads.length;i++){signal?.throwIfAborted();try{result.push(snapshotHistoryBatchItem(io.adapt(own(payloads,String(i)) as P)));}catch(error){throw new HistoryPollRunError('Adaptation',error);}}return result;
}
async function claim<P,T,A>(io:HistoryPollIo<P,T,A>,item:T,purpose:HistoryClaimPurpose,signal?:AbortSignal):Promise<HistoryClaimOutcome<A>>{
 const value=await step('Claim',signal,()=>io.claim(item,purpose,signal));try{const kind=own(value,'kind');if(kind==='Lost')return {kind};if(kind==='Won')return {kind,admitted:own(value,'admitted') as A};throw new TypeError('Expected durable claim disposition');}catch(error){throw new HistoryPollRunError('Claim',error);}
}
function stateStep<T>(stage:'State'|'Commit',run:()=>T):T{try{return run();}catch(error){throw new HistoryPollRunError(stage,error);}}
/** Claim calls are awaited because the TS store facade owns its SQLite worker.
 * No cursor commit on fetch/adapt/claim/process failure or cancellation. */
export async function runHistoryPollCycle<P,T,A>(state:HistoryPollState,channel:bigint,startedAt:bigint,input:HistoryPollIo<P,T,A>,signal?:AbortSignal):Promise<HistoryPollOutcome>{signal?.throwIfAborted();const cycle=stateStep('State',()=>HistoryPollState.prototype.begin.call(state,channel,startedAt));return runBegunHistoryPollCycle(state,channel,cycle,input,signal);}
async function runBegun<P,T,A>(state:HistoryPollState,channel:bigint,cycle:HistoryPollCycleToken,input:HistoryPollIo<P,T,A>,signal?:AbortSignal):Promise<HistoryPollOutcome>{
 signal?.throwIfAborted();stateStep('State',()=>HistoryPollState.prototype.requireCycleChannel.call(state,channel,cycle));const io=capture(input),rows=await batch(channel,io,signal),proposal=stateStep('State',()=>Reflect.apply(HistoryPollState.prototype.propose,state,[cycle,rows]) as HistoryPollProposal<T>),out={phase:proposal.phase,fetched:rows.length,noClaim:0,claimAttempted:0,claimWon:0,discarded:0,processed:0};
 for(const item of proposal.itemsOldestFirst){signal?.throwIfAborted();if(item.kind==='NoClaim'){out.noClaim++;continue;}out.claimAttempted++;const result=await claim(io,item.value,item.kind==='ClaimAndDiscard'?'Discard':'Process',signal);if(result.kind==='Won'){out.claimWon++;if(item.kind==='ClaimAndProcess'){await processOwned(io,result.admitted,signal);out.processed++;}}if(item.kind==='ClaimAndDiscard')out.discarded++;}
 signal?.throwIfAborted();stateStep('Commit',()=>HistoryPollState.prototype.commit.call(state,channel,proposal.commitToken));return Object.freeze(out);
}
/** A full ten-message window that never reaches the inclusive dropped-message
 * floor is Incomplete. Caller must retain its sticky gap, even if some work ran. */
async function runGap<P,T,A>(channel:bigint,inputFloor:HistoryWatermark,input:HistoryPollIo<P,T,A>,signal?:AbortSignal):Promise<HistoryGapOutcome>{
 signal?.throwIfAborted();if(typeof channel!=='bigint'||channel<0n||channel>=1n<<64n)throw new TypeError('Expected u64 channel');const floor=historyMessageWatermark(own(inputFloor,'micros') as bigint,own(inputFloor,'messageId') as bigint);if(floor===null)throw new TypeError('Expected message floor');const io=capture(input),rows=await batch(channel,io,signal);let oldest:HistoryWatermark|null=null;for(const row of rows)if(row.watermark!==null&&(oldest===null||compareHistoryWatermarks(row.watermark,oldest)<0))oldest=row.watermark;
 const out: {coverage:'Reached'|'Incomplete';fetched:number;noClaim:number;claimAttempted:number;claimWon:number;processed:number}={coverage:rows.length<HISTORY_POLL_PAGE_LIMIT||oldest!==null&&compareHistoryWatermarks(oldest,floor)<=0?'Reached':'Incomplete',fetched:rows.length,noClaim:0,claimAttempted:0,claimWon:0,processed:0};
 for(const row of rows.reverse()){signal?.throwIfAborted();if(row.watermark===null||row.item.kind==='Ignore'||compareHistoryWatermarks(row.watermark,floor)<0){out.noClaim++;continue;}out.claimAttempted++;const result=await claim(io,row.item.value,'Process',signal);if(result.kind==='Won'){out.claimWon++;await processOwned(io,result.admitted,signal);out.processed++;}}
 signal?.throwIfAborted();return Object.freeze(out);
}

const ioOwners=new WeakSet<object>(),channelOwners=new WeakMap<HistoryPollState,Set<bigint>>();
/** Borrowed IO has one actual owner until every started operation settles. */
export async function runBegunHistoryPollCycle<P,T,A>(state:HistoryPollState,channel:bigint,cycle:HistoryPollCycleToken,input:HistoryPollIo<P,T,A>,signal?:AbortSignal):Promise<HistoryPollOutcome>{
 signal?.throwIfAborted();HistoryPollState.prototype.requireCycleChannel.call(state,channel,cycle);capture(input);const channels=channelOwners.get(state)??new Set<bigint>();if(channels.has(channel)||ioOwners.has(input))throw new TypeError('History cycle already owned');channelOwners.set(state,channels);channels.add(channel);ioOwners.add(input);
 try{return await runBegun(state,channel,cycle,input,signal);}finally{channels.delete(channel);ioOwners.delete(input);}
}
export async function runHistoryGapRecovery<P,T,A>(channel:bigint,floor:HistoryWatermark,input:HistoryPollIo<P,T,A>,signal?:AbortSignal):Promise<HistoryGapOutcome>{
 signal?.throwIfAborted();capture(input);if(ioOwners.has(input))throw new TypeError('History IO already owned');ioOwners.add(input);try{return await runGap(channel,floor,input,signal);}finally{ioOwners.delete(input);}
}

async function processOwned<P,T,A>(io:HistoryPollIo<P,T,A>,admitted:A,signal?:AbortSignal):Promise<void>{const result:unknown=await step('Process',signal,()=>io.process(admitted,signal));if(result!==undefined)throw new HistoryPollRunError('Process',new TypeError('History process must return void'));}
