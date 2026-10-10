import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serdeField,serdeObject} from '../app-server/value.ts';
export interface ContextUsage {
 readonly lastInputTokens:bigint; readonly peakInputTokens:bigint;
 readonly lastTotalTokens:bigint|null; readonly modelContextWindow:bigint|null;
 readonly inferredCompactions:bigint; readonly lastCompaction:readonly [bigint,bigint]|null;
 readonly observedAt:string|null;
}
export class ContextUsageError extends Error {
 readonly detail:string;
 constructor(detail:string){super(`context observation is malformed: ${detail}`);this.name='ContextUsageError';this.detail=detail;}
}
const MAX_U64=(1n<<64n)-1n;
function number(value:unknown):bigint|null {
 if(value===null)return null;
 if(typeof value==='bigint'&&value>=0n&&value<=MAX_U64)return value;
 throw new ContextUsageError('token count or window must be a nonnegative integer');
}
/** Streaming accumulator for decoded Serde values. Integer tokens are bigint;
 * integral-looking floating/exponent tokens are not silently accepted as u64. */
export class ContextUsageAccumulator {
 #usage:ContextUsage|null=null; #window:bigint|null=null; #previous:bigint|null=null;
 push(input:unknown):void {
  const event=cloneOwnedSerdeValue(input);if(serdeField(event,'type')!=='event_msg')return;
  const payload=serdeField(event,'payload');switch(serdeField(payload,'type')){
   case 'task_started':this.#updateWindow(payload);break;
   case 'token_count':{
    const info=serdeField(payload,'info');if(info===null||info===undefined)return;
    if(!serdeObject(info))throw new ContextUsageError('token count info is not an object');
    this.#updateWindow(info);const last=serdeField(info,'last_token_usage');if(last!==null&&last!==undefined)this.#record(last,event);break;
   }
  }
 }
 #updateWindow(value:unknown):void {
  const raw=serdeField(value,'model_context_window');if(raw===undefined)return;
  const n=number(raw),next=n!==null&&n>0n?n:null;if(this.#window!==next)this.#previous=null;this.#window=next;
 }
 #record(last:unknown,event:unknown):void {
  const input=serdeField(last,'input_tokens');if(input===undefined)throw new ContextUsageError('input tokens missing');
  if(typeof input!=='bigint'||input<0n||input>MAX_U64)throw new ContextUsageError('input tokens must be a nonnegative integer');
  const rawTotal=serdeField(last,'total_tokens'),total=rawTotal===undefined?null:number(rawTotal),prior=this.#usage;
  let count=prior?.inferredCompactions??0n,compaction=prior?.lastCompaction??null;const previous=this.#previous;
  if(previous!==null&&previous>=50000n&&input>0n&&input<previous&&input*5n<previous*4n&&previous-input>=25000n){count=count===MAX_U64?count:count+1n;compaction=Object.freeze([previous,input] as const);}
  if(input>0n)this.#previous=input;
  const stamp=serdeField(event,'timestamp');this.#usage=Object.freeze({lastInputTokens:input,peakInputTokens:prior!==null&&prior.peakInputTokens>input?prior.peakInputTokens:input,lastTotalTokens:total,modelContextWindow:this.#window,inferredCompactions:count,lastCompaction:compaction,observedAt:typeof stamp==='string'?stamp:null});
 }
 finish():ContextUsage|null{return this.#usage;}
}
export function contextUsageFromEvents(events:Iterable<unknown>):ContextUsage|null {
 const state=new ContextUsageAccumulator();for(const event of events)state.push(event);return state.finish();
}
