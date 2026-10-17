import {Buffer} from 'node:buffer';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {cleanupRefusalFromOutcome,type CleanupRefusal} from '../../store/async-resolution-cleanup-refusal.ts';
import type {StoredIngress} from '../../store/ingress-read.ts';
import type {RunnerInspectionGlobalSnapshot} from '../../store/runner-inspection.ts';

/** A display limit, never execution/recovery authority. Full decoded input rows
 * are separately bounded by the worker's store reader before reaching here. */
export const RUNNER_INSPECTION_OUTPUT_BYTES=1024*1024;

export interface RunnerTargetDisplayContext {
 readonly target:string;
 readonly source:string;
 readonly owned:string;
}

/** Check each fragment before retaining it. In particular, neither JSON nor the
 * complete dashboard is constructed and only then compared with its limit. */
class BoundedDisplay {
 readonly #parts:string[]=[];
 #bytes=0;
 #check(bytes:number):void {
  if(bytes>RUNNER_INSPECTION_OUTPUT_BYTES-this.#bytes)throw new RangeError('Runner inspection output exceeds 1 MiB budget');
 }
 append(text:string):void {
  const bytes=Buffer.byteLength(text,'utf8');this.#check(bytes);this.#bytes+=bytes;if(text!=='')this.#parts.push(text);
 }
 indent(depth:number):void {
  const bytes=depth*2;this.#check(bytes);this.append(' '.repeat(bytes));
 }
 finish():string {return this.#parts.join('');}
}

const credentialKeys=new Set(['token','interactiontoken','accesstoken','refreshtoken','idtoken','sessiontoken','authorization','proxyauthorization','cookie','setcookie','password','passwd','apikey','clientsecret','secret','credentials','credential','otp','otpcode']);
const normalize=(s:string)=>s.replace(/[A-Z]/gu,c=>c.toLowerCase()).replace(/[_-]/gu,'');
const oneLine=(s:string)=>s.replace(/[\r\n]/gu,' ');

function redact(value:unknown):unknown {
 if(Array.isArray(value))return value.map(redact);
 if(value!==null&&typeof value==='object'){
  const out:Record<string,unknown>=Object.create(null);
  for(const [key,child] of Object.entries(value))if(!credentialKeys.has(normalize(key)))out[key]=redact(child);
  return out;
 }
 return value;
}

/** JSON.stringify is applied only to bounded string fragments, preserving its
 * exact escape spelling without ever creating a whole escaped payload string.
 * The caller first validates and owns the entire value, including redacted
 * fields, with the original cloneOwnedSerdeValue error semantics. */
function appendJsonString(out:BoundedDisplay,text:string):void {
 out.append('"');
 for(let start=0;start<text.length;){
  let end=Math.min(start+2048,text.length);
  const last=text.charCodeAt(end-1);
  if(last>=0xD800&&last<=0xDBFF)end--;
  out.append(JSON.stringify(text.slice(start,end)).slice(1,-1));start=end;
 }
 out.append('"');
}

/** Equivalent to serializePrettySerdeValue for the already validated display
 * copy: UTF-8 key order, two-space indentation, empty containers, all original
 * string escapes and the lossless Serde number/bigint spelling are retained. */
function appendPrettySerdeValue(out:BoundedDisplay,value:unknown,depth=0):void {
 if(typeof value==='string'){appendJsonString(out,value);return;}
 if(value===null||typeof value!=='object'){out.append(serializeSerdeValue(value));return;}
 if(Array.isArray(value)){
  if(value.length===0){out.append('[]');return;}
  out.append('[');
  for(let i=0;i<value.length;i++){
   out.append(i===0?'\n':',\n');out.indent(depth+1);appendPrettySerdeValue(out,value[i],depth+1);
  }
  out.append('\n');out.indent(depth);out.append(']');return;
 }
 const keys=Object.keys(value).sort((a,b)=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8')));
 if(keys.length===0){out.append('{}');return;}
 out.append('{');
 for(let i=0;i<keys.length;i++){
  const key=keys[i]!;out.append(i===0?'\n':',\n');out.indent(depth+1);appendJsonString(out,key);out.append(': ');
  appendPrettySerdeValue(out,(value as Record<string,unknown>)[key],depth+1);
 }
 out.append('\n');out.indent(depth);out.append('}');
}

function refusalMessage(refusal:CleanupRefusal):string {
 return `Mirror sync stopped.\nroom: ${refusal.room}\nreason: ${refusal.reason}\nNo deletion was dispatched for this room. Earlier sync changes may have completed.\nPending work is preserved; this request will not retry automatically.`;
}

function refusalSummary(refusal:CleanupRefusal):string {
 return `Mirror sync stopped: room ${refusal.room} protected by ${refusal.reason}; notification confirmation not recorded. No deletion dispatched for this room; earlier changes may have completed. No automatic retry.`;
}

/** Pure authorized display copy. Only credential field names are removed;
 * literal prompt contents and every stored bigint retain their exact meaning. */
export function formatSavedRequestMessage(record:StoredIngress):string {
 const refusal=cleanupRefusalFromOutcome(record.outcome);
 // Preserve the original validation/ownership boundary before any redaction.
 const payload=redact(cloneOwnedSerdeValue(record.payload)),out=new BoundedDisplay();
 out.append('Saved Discord request (read-only)\nrequest_id: ');out.append(record.ingressId);
 out.append('\nstate: ');out.append(record.state);out.append('\nphase: ');out.append(record.phase);
 out.append('\ntarget: ');out.append(record.targetThreadId??'not yet known');out.append('\nreason: ');out.append(record.holdReason);
 if(refusal!==undefined){out.append('\nknown_outcome: ');out.append(refusalMessage(refusal));out.append('\nnotification_confirmed: ');out.append(String(record.confirmationDelivered));}
 out.append('\nThis does not retry, release, or delete the request.\nOriginal payload below omits credential fields only.\noriginal_payload:\n');
 appendPrettySerdeValue(out,payload);return out.finish();
}

export function formatSavedRequestSummary(records:readonly StoredIngress[]):string {
 const out=new BoundedDisplay();out.append('Your saved requests needing attention (latest 20):');
 for(const record of records){
  out.append('\n');out.append(record.ingressId);
  const refusal=cleanupRefusalFromOutcome(record.outcome);
  if(refusal!==undefined){
   out.append(' | status: sync stopped; notification unconfirmed | reason: ');
   out.append(oneLine(record.holdReason===''?refusalSummary(refusal):record.holdReason));continue;
  }
  const [status,reason]=record.phase==='cancelled'?['cancelled; original confirmation pending','request cancelled by its original sender; no execution retry']:record.state==='completed'?['execution completed; confirmation pending','confirmation delivery not recorded']:['saved; manual review required','manual review required'];
  out.append(' | status: ');out.append(status!);out.append(' | target: ');out.append(oneLine(record.targetThreadId??'not yet known'));
  out.append(' | reason: ');out.append(oneLine(record.holdReason===''?reason!:record.holdReason));
 }
 if(records.length===0)out.append('\nnone');
 out.append('\nInspect: !runners <request_id> (original user and channel only).');return out.finish();
}

export function formatRunnersMessage(snapshot:RunnerInspectionGlobalSnapshot):string {
 const {jobs,pending,unknown,blocked,intakes,held}=snapshot;
 const count=(state:string)=>jobs.filter(j=>j.state===state).length,backoff=intakes.filter(i=>i.lastError!=='').length;
 const out=new BoundedDisplay();out.append('Codex runners\nexecution_held (explicit recovery required): ');
 if(held.length===0)out.append('none');
 else for(let i=0;i<held.length;i++){if(i>0)out.append('\n');out.append(held[i]!);}
 out.append('\npending: ');out.append(String(count('Pending')));out.append('\nstarting: ');out.append(String(count('Starting')));
 out.append('\nrunning: ');out.append(String(count('Running')));out.append('\nquarantined: ');out.append(String(count('Quarantined')));
 out.append('\nfinal_pending: ');out.append(String(pending));out.append('\nsends_unconfirmed: ');out.append(String(unknown));
 out.append(' (not automatically resent)\nsends_rejected: ');out.append(String(blocked));
 out.append(' (requires correction; no automatic retry)\nrecoverable_intakes: ');out.append(String(intakes.length));
 out.append('\nintake_backoff: ');out.append(String(backoff));return out.finish();
}

/** Context is captured and bounded by the owner before entering the worker. */
export function formatRunnerTargetSummary(counts:readonly bigint[],context:RunnerTargetDisplayContext):string {
 const out=new BoundedDisplay();out.append('Current target work (stored counts and resident ownership check; no remote probe)\ntarget: ');
 out.append(context.target);out.append('\nsource: ');out.append(context.source);out.append('\n');out.append(context.owned);
 const labels=['queued','starting','running_records','intake','held_ingress','unowned_ingress','quarantined_records'];
 for(let i=0;i<labels.length;i++){out.append('\n');out.append(labels[i]!);out.append(': ');out.append(String(counts[i]));}
 return out.finish();
}

/** Final aggregation is bounded before join allocation as well as per section. */
export function joinRunnerInspectionMessages(messages:readonly string[],separator='\n\n'):string {
 const out=new BoundedDisplay();
 for(let i=0;i<messages.length;i++){if(i>0)out.append(separator);out.append(messages[i]!);}
 return out.finish();
}
