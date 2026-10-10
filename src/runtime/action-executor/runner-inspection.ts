import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {cleanupRefusalFromOutcome,type CleanupRefusal} from '../../store/async-resolution-cleanup-refusal.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serializePrettySerdeValue} from '../../core/serde-json-pretty.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {ActionThreadSelection} from './thread-selection.ts';
import {ControlTurnVerifier} from './control-turn.ts';
import {runnersMessage} from './runners-status.ts';
import {InvalidActionRequestError,MissingActionAppServerError,NoActionTargetError,ActionIntegerRangeError} from './errors.ts';
const oneLine=(s:string)=>s.replace(/[\r\n]/gu,' ');
const credentialKeys=new Set(['token','interactiontoken','accesstoken','refreshtoken','idtoken','sessiontoken','authorization','proxyauthorization','cookie','setcookie','password','passwd','apikey','clientsecret','secret','credentials','credential','otp','otpcode']);
const normalize=(s:string)=>s.replace(/[A-Z]/gu,c=>c.toLowerCase()).replace(/[_-]/gu,'');
function redact(value:unknown):unknown {
 if(Array.isArray(value))return value.map(redact);
 if(value!==null&&typeof value==='object'){const out:Record<string,unknown>=Object.create(null);for(const [key,child] of Object.entries(value))if(!credentialKeys.has(normalize(key)))out[key]=redact(child);return out;}return value;
}
function identity(id:bigint):bigint{if(typeof id!=='bigint'||id<0n||id>=1n<<63n)throw new ActionIntegerRangeError();return id;}
function refusalMessage(refusal:CleanupRefusal):string{return `Mirror sync stopped.\nroom: ${refusal.room}\nreason: ${refusal.reason}\nNo deletion was dispatched for this room. Earlier sync changes may have completed.\nPending work is preserved; this request will not retry automatically.`;}
function refusalSummary(refusal:CleanupRefusal):string{return `Mirror sync stopped: room ${refusal.room} protected by ${refusal.reason}; notification confirmation not recorded. No deletion dispatched for this room; earlier changes may have completed. No automatic retry.`;}
/** Authorized display copy only: field-name redaction leaves prompt contents and
 * exact stored evidence unchanged. No retries, release, deletion or raw logging. */
export async function savedRequestMessage(path:string,channel:bigint,user:bigint,requestId:string,signal?:AbortSignal):Promise<string>{
 requireDiscordText(path);requireDiscordText(requestId);identity(channel);identity(user);signal?.throwIfAborted();
 const record=state.getIngressForOwnerReadonly(path,requestId,channel,user);if(record===null)throw new InvalidActionRequestError('saved request is unavailable for this user and channel');
 const refusal=cleanupRefusalFromOutcome(record.outcome),known=refusal===undefined?'':`\nknown_outcome: ${refusalMessage(refusal)}\nnotification_confirmed: ${record.confirmationDelivered}`;
 const payload=serializePrettySerdeValue(redact(cloneOwnedSerdeValue(record.payload)));signal?.throwIfAborted();
 return `Saved Discord request (read-only)\nrequest_id: ${record.ingressId}\nstate: ${record.state}\nphase: ${record.phase}\ntarget: ${record.targetThreadId??'not yet known'}\nreason: ${record.holdReason}${known}\nThis does not retry, release, or delete the request.\nOriginal payload below omits credential fields only.\noriginal_payload:\n${payload}`;
}
export async function savedRequestSummary(path:string,channel:bigint,user:bigint,signal?:AbortSignal):Promise<string>{
 identity(channel);identity(user);signal?.throwIfAborted();const records=await state.listIngressesForOwner(path,channel,user);signal?.throwIfAborted();const lines=['Your saved requests needing attention (latest 20):'];
 for(const record of records){
  const refusal=cleanupRefusalFromOutcome(record.outcome);if(refusal!==undefined){lines.push(`${record.ingressId} | status: sync stopped; notification unconfirmed | reason: ${oneLine(record.holdReason===''?refusalSummary(refusal):record.holdReason)}`);continue;}
  const [status,reason]=record.phase==='cancelled'?['cancelled; original confirmation pending','request cancelled by its original sender; no execution retry']:record.state==='completed'?['execution completed; confirmation pending','confirmation delivery not recorded']:['saved; manual review required','manual review required'];
  lines.push(`${record.ingressId} | status: ${status} | target: ${oneLine(record.targetThreadId??'not yet known')} | reason: ${oneLine(record.holdReason===''?reason!:record.holdReason)}`);
 }
 if(lines.length===1)lines.push('none');lines.push('Inspect: !runners <request_id> (original user and channel only).');return lines.join('\n');
}
export class RunnerInspection {
 readonly #path:string;readonly #selection:ActionThreadSelection;readonly #control:ControlTurnVerifier;
 constructor(path:string,selection:ActionThreadSelection,control:ControlTurnVerifier){requireDiscordText(path);this.#path=path;this.#selection=selection;this.#control=control;Object.freeze(this);}
 async targetSummary(channel:bigint,signal?:AbortSignal):Promise<string>{
  signal?.throwIfAborted();let target:string,source:string;
  try{[target,source]=await this.#selection.target(channel);}catch(error){signal?.throwIfAborted();if(error instanceof NoActionTargetError)return `Current target lookup failed: ${error.message}. Global counts and your saved requests remain available; no target was substituted.`;throw error;}
  signal?.throwIfAborted();let owned:string;
  try{const [turn,generation]=await this.#control.control(channel,target);owned=`owned_active_turn: ${turn}\nconnection_generation: ${generation}`;}catch(error){if(!(error instanceof InvalidActionRequestError)&&!(error instanceof MissingActionAppServerError))throw error;owned=`owned_active_turn: unknown\nactive_check: ${error.message}`;}
  signal?.throwIfAborted();const c=await state.runnerTargetCounts(this.#path,target);signal?.throwIfAborted();return `Current target work (stored counts and resident ownership check; no remote probe)\ntarget: ${target}\nsource: ${source}\n${owned}\nqueued: ${c[0]}\nstarting: ${c[1]}\nrunning_records: ${c[2]}\nintake: ${c[3]}\nheld_ingress: ${c[4]}\nunowned_ingress: ${c[5]}\nquarantined_records: ${c[6]}`;
 }
 async runners(channel:bigint,user:bigint,signal?:AbortSignal):Promise<string>{return `${await runnersMessage(this.#path,signal)}\n\n${await this.targetSummary(channel,signal)}\n\n${await savedRequestSummary(this.#path,channel,user,signal)}`;}
}
Object.freeze(RunnerInspection.prototype);
