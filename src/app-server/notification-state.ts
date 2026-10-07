import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {boundedSerdeByteCount} from "../core/serde-byte-count.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import {serdeField} from "./value.ts";
import {extractThreadId,extractTurnId} from "./identity.ts";
const MAX_U64=(1n<<64n)-1n;
export interface AppNotification{readonly method:string;readonly params:unknown}
export interface ObservationWindow{readonly ownerId:string;readonly generation:bigint;readonly firstAvailable:bigint;readonly sourceUpper:bigint;readonly upper:bigint;readonly scannedThrough:bigint;readonly events:readonly {readonly sequence:bigint;readonly notification:AppNotification|null}[]}
export class IdleObservationError extends Error{readonly kind="IdleRelease";constructor(detail:string){super(`idle subscription release: ${detail}`);this.name="IdleObservationError";}}
function u64(value:bigint):void{if(typeof value!=="bigint"||value<0n||value>MAX_U64)throw new TypeError("Expected u64 observation sequence");}
export function nextNotificationRevision(current:bigint):{revision:bigint;exhausted:boolean}{u64(current);return current===MAX_U64?{revision:current,exhausted:true}:{revision:current+1n,exhausted:false};}
function copy(input:AppNotification):AppNotification{const method=serdeField(input,"method");if(typeof method!=="string"||/[\uD800-\uDFFF]/u.test(method))throw new TypeError("Expected notification method");return Object.freeze({method,params:cloneOwnedSerdeValue(serdeField(input,"params"))});}
/** Central transient notification owner only, not resident process lifecycle or idle
 * release authority. A parent must bind window owner/generation and prove ledger facts. */
export class NotificationState{
  readonly #active=new Map<string,string>();readonly #notifications:AppNotification[]=[];
  #revision=0n;#exhausted=false;#observed=0n;#gap=false;#ledger:bigint|null=null;#ledgerRequired:boolean;#closed=false;
  constructor(ledgerRequired=false){if(typeof ledgerRequired!=="boolean")throw new TypeError("Expected ledger installation flag");this.#ledgerRequired=ledgerRequired;}
  get notificationRevision():bigint{return this.#revision;}
  get retainedCount():number{return this.#notifications.length;}
  get hasActiveTurns():boolean{return this.#active.size>0;}
  activeTurnId(thread:string):string|null{return this.#active.get(thread)??null;}
  close():void{this.#closed=true;}
  record(input:AppNotification):void{
    const notification=copy(input),next=nextNotificationRevision(this.#revision);this.#revision=next.revision;this.#exhausted||=next.exhausted;
    const thread=extractThreadId(notification.params),turn=extractTurnId(notification.params);
    if(notification.method==="turn/started"&&thread!==null&&turn!==null)this.#active.set(thread,turn);
    else if(notification.method==="turn/completed"&&thread!==null&&turn!==null&&this.#active.get(thread)===turn)this.#active.delete(thread);
    this.#notifications.push(notification);if(this.#notifications.length>1000)this.#notifications.shift();
  }
  confirmIdleObservation(input:AppNotification):boolean{
    if(this.#exhausted)return false;const notification=copy(input),first=this.#revision-BigInt(this.#notifications.length)+1n,next=this.#observed+1n;
    if(next<first){this.#gap=true;return false;}const index=next-first,actual=index>=0n&&index<BigInt(this.#notifications.length)?this.#notifications[Number(index)]:undefined;
    if(actual===undefined||actual.method!==notification.method||!serdeValueEqual(actual.params,notification.params)){this.#gap=true;return false;}
    this.#observed=next;return true;
  }
  get idleObservationsCaughtUp():boolean{return !this.#exhausted&&(this.#ledgerRequired?this.#ledger===this.#revision:!this.#gap&&this.#observed===this.#revision);}
  witnessedIdleTerminal(thread:string,turn:string):boolean{
    for(let i=this.#notifications.length-1;i>=0;i--){const n=this.#notifications[i]!;if((n.method==="turn/started"||n.method==="turn/completed")&&extractThreadId(n.params)===thread)return n.method==="turn/completed"&&extractTurnId(n.params)===turn;}return false;
  }
  observedThreadSettings(thread:string):readonly [bigint,unknown]|null{
    if(this.#closed)return null;for(let offset=0;offset<this.#notifications.length;offset++){
      const n=this.#notifications[this.#notifications.length-1-offset]!;if(extractThreadId(n.params)!==thread)continue;
      if(n.method==="thread/closed"||(n.method==="thread/status/changed"&&serdeField(serdeField(n.params,"status"),"type")==="notLoaded"))return null;
      if(n.method==="thread/settings/updated")return Object.freeze([this.#revision-BigInt(offset),serdeField(n.params,"threadSettings")??null]);
    }return null;
  }
  /** Unbound source window; None retains an oversized occurrence's exact sequence. */
  observationWindow(after:bigint,requestedUpper:bigint|null=null):ObservationWindow{
    u64(after);if(requestedUpper!==null)u64(requestedUpper);if(this.#exhausted)throw new IdleObservationError("source sequence exhausted");
    const upper=requestedUpper??this.#revision;if(upper>this.#revision||after>upper)throw new IdleObservationError("invalid observation window");
    const first=this.#revision-BigInt(this.#notifications.length)+1n,next=after===MAX_U64?MAX_U64:after+1n,begin=next>first?next:first;
    let scanned=upper<begin-1n?upper:begin-1n,used=0;const events:{sequence:bigint;notification:AppNotification|null}[]=[];
    for(let offset=0;offset<this.#notifications.length;offset++){
      const sequence=first+BigInt(offset);if(sequence<begin)continue;if(sequence>upper||events.length>=32)break;
      const n=this.#notifications[offset]!,base=used+Buffer.byteLength(n.method),size=base>2*1024*1024?null:boundedSerdeByteCount(n.params,2*1024*1024-base);
      if(size!==null)used=base+size;events.push(Object.freeze({sequence,notification:size===null?null:n}));scanned=sequence;
    }
    return Object.freeze({ownerId:"",generation:0n,firstAvailable:first,sourceUpper:this.#revision,upper,scannedThrough:scanned,events:Object.freeze(events)});
  }
  /** INTERNAL TRUSTED transition: caller must have proven the durable ledger prefix.
   * This operation is not itself proof and must never be driven by raw user input. */
  certifyObservationPrefix(through:bigint):boolean{u64(through);if(this.#exhausted||through>this.#revision)return false;this.#ledger=through;this.#gap=false;return true;}
}
