import {AppServerClosedError} from "./client-errors.ts";
import {NotificationState,type AppNotification} from "./notification-state.ts";
import {ServerRequestState,type PendingServerRequest,type ServerRequestRecordOutcome} from "./server-request-state.ts";
import {ServerRequestOccurrence,type RequestId} from "../protocol/ids.ts";
import {serdeField} from "./value.ts";
export interface ClientLifecycleSnapshot{readonly generation:bigint;readonly healthy:boolean;readonly initialized:boolean;readonly processId:number|null;readonly closedReason:string|null}
export interface DeadGenerationWork{readonly generation:bigint;readonly closedReason:string;readonly activeTurns:readonly {readonly threadId:string;readonly turnId:string}[];readonly serverRequests:readonly PendingServerRequest[]}
export {AppServerClosedError} from "./client-errors.ts";
const APPROVAL_METHODS=new Set(["item/commandExecution/requestApproval","item/fileChange/requestApproval","item/permissions/requestApproval","execCommandApproval","applyPatchApproval"]);
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed client state text");}
function compareId(a:RequestId,b:RequestId):number{if(typeof a==="bigint")return typeof b==="bigint"?(a<b?-1:a>b?1:0):-1;if(typeof b==="bigint")return 1;return Buffer.compare(Buffer.from(a),Buffer.from(b));}
/** Single client-state owner composed from the source's transient submodules.
 * Not resident replacement state, a live process handle, or an exit/fence proof. */
export class ClientRuntimeState{
  readonly #notifications:NotificationState;readonly #requests=new ServerRequestState();#processId:number|null;
  #initialized=false;#generation=0n;#closedReason:string|null=null;
  constructor(processId:number|null=null,ledgerRequired=false){if(processId!==null&&(!Number.isInteger(processId)||processId<0||processId>0xffffffff))throw new TypeError("Expected optional u32 process ID");this.#processId=processId;this.#notifications=new NotificationState(ledgerRequired);}
  /** Trusted startup commit AFTER initialize ACK/initialized write and inside an open lifecycle gate. */
  commitInitialized():void{if(this.#closedReason!==null)throw new AppServerClosedError();this.#initialized=true;this.#generation=1n;}
  snapshot():ClientLifecycleSnapshot{return Object.freeze({generation:this.#generation,healthy:this.#initialized&&this.#closedReason===null&&this.#processId!==null,initialized:this.#initialized,processId:this.#processId,closedReason:this.#closedReason});}
  /** Caller supplies the transport/lifecycle's already-resolved canonical close reason.
   * Mirrors transport.rs flag clearing, without claiming OS exit or publishing close watchers. */
  publishClosedReason(reason:string):string{return this.claimTransportClose(reason).reason;}
  /** Atomic first-closer claim for the transport coordinator; no watcher publication. */
  claimTransportClose(reason:string):Readonly<{reason:string;first:boolean}>{text(reason);this.#initialized=false;this.#processId=null;const first=this.#closedReason===null;if(first){this.#closedReason=reason;this.#notifications.close();}return Object.freeze({reason:this.#closedReason!,first});}
  recordNotification(notification:AppNotification):void{this.#notifications.record(notification);}
  activeTurnId(thread:string):string|null{return this.#notifications.activeTurnId(thread);}
  get hasActiveTurns():boolean{return this.#notifications.hasActiveTurns;}
  get notificationRevision():bigint{return this.#notifications.notificationRevision;}
  observedThreadSettings(thread:string):readonly [bigint,unknown]|null{return this.#notifications.observedThreadSettings(thread);}
  confirmIdleObservation(notification:AppNotification):boolean{return this.#notifications.confirmIdleObservation(notification);}
  get idleObservationsCaughtUp():boolean{return this.#notifications.idleObservationsCaughtUp;}
  witnessedIdleTerminal(thread:string,turn:string):boolean{return this.#notifications.witnessedIdleTerminal(thread,turn);}
  observationWindow(after:bigint,upper:bigint|null=null){return this.#notifications.observationWindow(after,upper);}
  /** Requires the parent observer's proven durable prefix; no raw-input authority. */
  certifyObservationPrefix(through:bigint):boolean{return this.#notifications.certifyObservationPrefix(through);}
  recordServerRequest(request:PendingServerRequest):ServerRequestRecordOutcome{return this.#requests.record(request);}
  beginServerResponse(id:RequestId,occurrence:ServerRequestOccurrence):void{this.#requests.beginResponse(id,occurrence);}
  serverResponseCandidate(id:RequestId,occurrence:ServerRequestOccurrence):PendingServerRequest{return this.#requests.responseCandidate(id,occurrence);}
  markServerResponseIndeterminate(id:RequestId,occurrence:ServerRequestOccurrence):void{this.#requests.markIndeterminate(id,occurrence);}
  resolveServerRequest(id:RequestId,occurrence:ServerRequestOccurrence):PendingServerRequest|null{return this.#requests.resolve(id,occurrence);}
  pendingServerRequests(thread:string|null=null):PendingServerRequest[]{return this.#requests.pending(thread);}
  unsettledServerRequests(thread:string|null=null):PendingServerRequest[]{return this.#requests.unsettled(thread);}
  get hasUnsettledServerRequests():boolean{return this.#requests.hasUnsettled;}
  latestApprovalRequest(thread:string):PendingServerRequest|null{return this.pendingServerRequests(thread).reverse().find(r=>APPROVAL_METHODS.has(r.method)||(r.method==="mcpServer/elicitation/request"&&serdeField(r.params,"mode")==="url"))??null;}
  latestInputRequest(thread:string):PendingServerRequest|null{return this.pendingServerRequests(thread).reverse().find(r=>r.method==="item/tool/requestUserInput")??null;}
  /** Read-only sorted snapshot, including claimed/indeterminate/deferred requests.
   * No bulk clear or settlement API is exposed without the future exact durable fence. */
  deadGenerationWork(generation:bigint):DeadGenerationWork|null{
    if(typeof generation!=="bigint"||generation<0n||generation>=(1n<<64n))throw new TypeError("Expected u64 dead generation");if(this.#closedReason===null)return null;
    const requests=this.#requests.unsettled().sort((a,b)=>compareId(a.id,b.id)||Buffer.compare(ServerRequestOccurrence.prototype.asBytes.call(a.occurrence),ServerRequestOccurrence.prototype.asBytes.call(b.occurrence)));
    return Object.freeze({generation,closedReason:this.#closedReason,activeTurns:this.#notifications.activeTurnIdentities(),serverRequests:Object.freeze(requests)});
  }
}
export function deadGenerationWorkIsEmpty(work:DeadGenerationWork):boolean{return work.activeTurns.length===0&&work.serverRequests.length===0;}
