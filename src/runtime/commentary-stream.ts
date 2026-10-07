import {serdeField,trimmedText} from "../app-server/value.ts";
import {isAsyncAgentMessage} from "../app-server/outcomes.ts";
export interface CommentaryBlock{readonly threadId:string;readonly turnId:string;readonly text:string}
const MAX_ACTIVE_ITEMS=128,MAX_ITEM_BYTES=16*1024;
interface Item{thread:string;turn:string;summary:string;bytes:number}
function key(thread:string,turn:string,item:string):string{return JSON.stringify([thread,turn,item]);}
/** Bounded reasoning-summary retention, but only completed user-facing commentary emits.
 * No reasoning delta or summary buffer is exposed as a progress reply. */
export class CommentaryBuffer{
  readonly #items=new Map<string,Item>();
  get activeItems():number{return this.#items.size;}
  /** Diagnostic byte count excludes identity/map overhead; not total process memory. */
  get retainedSummaryBytes():number{let total=0;for(const item of this.#items.values())total+=item.bytes;return total;}
  discardTurn(threadId:string,turnId:string):void{for(const [id,item]of this.#items)if(item.thread===threadId&&item.turn===turnId)this.#items.delete(id);}
  observe(method:string,params:unknown):CommentaryBlock|null{
    if(method==="item/reasoning/summaryTextDelta"){this.#append(params);return null;}
    if(method!=="item/completed")return null;
    const thread=trimmedText(serdeField(params,"threadId")),turn=trimmedText(serdeField(params,"turnId")),item=serdeField(params,"item"),id=trimmedText(serdeField(item,"id"));
    if(thread===""||turn===""||id==="")return null;
    this.#items.delete(key(thread,turn,id));
    if(isAsyncAgentMessage(item)||trimmedText(serdeField(item,"type"))!=="agentMessage"||trimmedText(serdeField(item,"phase"))!=="commentary")return null;
    const text=trimmedText(serdeField(item,"text"));return text===""?null:Object.freeze({threadId:thread,turnId:turn,text});
  }
  #append(params:unknown):void{
    const thread=trimmedText(serdeField(params,"threadId")),turn=trimmedText(serdeField(params,"turnId")),id=trimmedText(serdeField(params,"itemId")),delta=serdeField(params,"delta");
    if(thread===""||turn===""||id===""||typeof delta!=="string")return;
    const identity=key(thread,turn,id);let item=this.#items.get(identity);
    if(item===undefined){if(this.#items.size>=MAX_ACTIVE_ITEMS)return;item={thread,turn,summary:"",bytes:0};this.#items.set(identity,item);}
    let remaining=MAX_ITEM_BYTES-item.bytes;if(remaining===0)return;let end=0,added=0;
    for(const char of delta){const bytes=Buffer.byteLength(char,"utf8");if(bytes>remaining)break;remaining-=bytes;added+=bytes;end+=char.length;}
    item.summary+=delta.slice(0,end);item.bytes+=added;
  }
}
