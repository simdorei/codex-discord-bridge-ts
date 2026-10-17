import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serdeField,rustTrim} from '../app-server/value.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
export type RecentTextMode='Visible'|'UserAndFinal';
export interface ContextTextItem {readonly label:'user'|'assistant final'|'assistant commentary'|'assistant interactive';readonly text:string;readonly observedAt:string|null;readonly truncated:boolean;}
const chars=(text:string,n:number):string=>{let out='',count=0;for(const c of text){if(count++>=n)break;out+=c;}return out;};
function stamp(event:unknown):string|null{const s=serdeField(event,'timestamp');return typeof s==='string'?chars(s,64):null;}
function extract(event:unknown):ContextTextItem|null {
 const payload=serdeField(event,'payload'),type=serdeField(event,'type'),kind=serdeField(payload,'type'),rawPhase=serdeField(payload,'phase'),phase=typeof rawPhase==='string'?rawPhase:'commentary';if(phase==='analysis')return null;
 let role:unknown,fragments:string[]=[];
 if(type==='event_msg'&&(kind==='user_message'||kind==='agent_message')){role=kind==='user_message'?'user':'assistant';const text=serdeField(payload,'message');if(typeof text!=='string')return null;fragments=[text];}
 else if(type==='response_item'&&kind==='message'){
  role=serdeField(payload,'role');const content=serdeField(payload,'content');if(!Array.isArray(content))return null;for(const item of content){const k=serdeField(item,'type'),text=serdeField(item,'text');if((k==='input_text'||k==='output_text')&&typeof text==='string')fragments.push(text);}
 }else if(type==='response_item'&&kind==='function_call'){
  const name=serdeField(payload,'name');if(typeof name!=='string')return null;let text:string;
  if(name.endsWith('request_user_input'))text='[choice_required]';else{const raw=serdeField(payload,'arguments');if(typeof raw!=='string')return null;let args:unknown;try{args=parseSerdeValue(raw);}catch{return null;}if(serdeField(args,'sandbox_permissions')!=='require_escalated')return null;text='[approval_required]';}
  return Object.freeze({label:'assistant interactive',text,observedAt:stamp(event),truncated:false});
 }else return null;
 const label=role==='user'?'user':role==='assistant'?(phase==='final'||phase==='final_answer'?'assistant final':'assistant commentary'):null;if(label===null)return null;
 let text='',count=0;for(const fragment of fragments){if(text!==''){text+='\n';count++;}const part=chars(fragment,Math.max(0,1501-count));text+=part;count+=[...part].length;if(count>1500)break;}
 const truncated=count>1500;text=rustTrim(chars(text,1500));if(text==='')return null;return Object.freeze({label,text,observedAt:stamp(event),truncated});
}
/** Chronological occurrences, never content-based deduplication. Eligibility is
 * applied before consuming the bounded window. Raw tool arguments never escape. */
export class RecentText {
 readonly #limit:number;readonly #mode:RecentTextMode;#items:ContextTextItem[]=[];
 constructor(limit:number,mode:RecentTextMode='Visible'){if(!Number.isSafeInteger(limit)||limit<0)throw new TypeError('Expected nonnegative recent text limit');if(mode!=='Visible'&&mode!=='UserAndFinal')throw new TypeError('Unknown recent text mode');this.#limit=Math.min(50,Math.max(1,limit));this.#mode=mode;}
 push(input:unknown):void{const item=extract(cloneOwnedSerdeValue(input));if(item===null||(this.#mode==='UserAndFinal'&&item.label!=='user'&&item.label!=='assistant final'))return;if(this.#items.length===this.#limit)this.#items.shift();this.#items.push(item);}
 finish():readonly ContextTextItem[]{return Object.freeze([...this.#items]);}
}
