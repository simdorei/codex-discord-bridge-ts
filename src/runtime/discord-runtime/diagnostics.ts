import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {actionExecutionErrorInfo} from '../action-executor/action-error.ts';

function field(value:unknown,key:string):unknown{
 if(value===null||typeof value!=='object'||types.isProxy(value))return undefined;
 const descriptor=Object.getOwnPropertyDescriptor(value,key);
 return descriptor!==undefined&&Object.hasOwn(descriptor,'value')?descriptor.value:undefined;
}
function category(value:unknown):string{
 const text=typeof value==='string'?value.slice(0,4096):'';
 if(/SQLITE_BUSY|SQLITE_LOCKED|database is (?:locked|busy)/i.test(text))return 'DatabaseBusy';
 if(/timed? ?out|deadline/i.test(text))return 'Timeout';
 if(/EPERM|EACCES|permission denied|access denied/i.test(text))return 'PermissionDenied';
 if(/ENOENT|not found|unavailable.*(?:path|directory)|directory.*unavailable/i.test(text))return 'MissingResource';
 if(/rate.?limit|too many requests/i.test(text))return 'RateLimited';
 if(/no .*target|target.*(?:missing|changed)|mapping.*(?:missing|changed)/i.test(text))return 'TargetUnavailable';
 if(/outcome.*unknown|unconfirmed|acknowledgement|ownership retained/i.test(text))return 'OutcomeUnconfirmed';
 if(/capacity|slot.*(?:busy|occupied)|worker.*(?:busy|occupied)/i.test(text))return 'CapacityBusy';
 if(/invalid|malformed|unsupported/i.test(text))return 'InvalidOperation';
 if(/disconnect|connection|ECONN|socket/i.test(text))return 'ConnectionFailure';
 if(/abort|cancel/i.test(text))return 'Cancelled';
 return 'OperationFailure';
}
const labels=['kind','name','code','phase','method','operation','tag','status','statusCode','httpStatus','win32Code','errno','syscall'] as const;
const identities=['thread','threadId','thread_id','targetThreadId','channel','channelId','channel_id','requestId','request_id','jobId','job_id','ingressId'] as const;
const children=['error','cause','failure','primary','cleanup','outcome','result','target','finished','decision','report','settled','errors','rows'] as const;
/** Local structured diagnostics intentionally omit raw messages, stack, payload,
 * paths and arbitrary properties. Only bounded passive classifications and
 * recognized IDs leave this boundary; a digest distinguishes omitted causes.
 * Stable per-run IDs keep retry deduplication intact and correlate render/log. */
export function createRuntimeDiagnostics(write:(line:string)=>unknown,secrets:readonly string[]=[]){
 const salt=randomUUID(),hidden=secrets.filter(s=>typeof s==='string'&&s.length>0);
 const safeLabel=(value:unknown):string|number|undefined=>{
  if(typeof value==='number'&&Number.isSafeInteger(value))return value;
  if(typeof value!=='string'||value.length>80||!/^[A-Za-z][A-Za-z0-9_./:-]*$/.test(value))return undefined;
  if(hidden.some(s=>value.includes(s))||value.length>=24&&/[a-z]/.test(value)&&/[A-Z]/.test(value)&&/[0-9]/.test(value))return '[REDACTED]';
  return value;
 };
 const idText=(value:unknown):string|undefined=>{
  if(typeof value==='bigint'&&value>=0n&&value<1n<<64n)return value.toString();
  if(typeof value==='string'&&value.length<=128&&!hidden.some(s=>value.includes(s))&&/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:message:|interaction:)?[0-9]{1,20})$/i.test(value))return value;
  return undefined;
 };
 const fingerprint=(text:string)=>createHash('sha256').update(salt).update(text).digest('hex').slice(0,16);
 const summarize=(input:unknown)=>{
  const seen=new WeakSet<object>();let budget=40;
  const visit=(value:unknown,depth:number):unknown=>{
   if(depth>6||budget--<=0)return {omitted:'budget'};
   if(value===null||typeof value!=='object'||types.isProxy(value))return typeof value==='string'?{category:category(value)}:undefined;
   if(seen.has(value))return {omitted:'cycle'};seen.add(value);
   if(Array.isArray(value)){
    const length=field(value,'length');if(typeof length!=='number')return undefined;
    const rows=[];for(let i=0;i<Math.min(length,8);i++){const row=visit(field(value,String(i)),depth+1);if(row!==undefined)rows.push(row);}
    return rows;
   }
   const result:Record<string,unknown>={};
   for(const key of labels){const text=safeLabel(field(value,key));if(text!==undefined)result[key]=text;}
   for(const key of identities){const text=idText(field(value,key));if(text!==undefined)result[key]=text;}
   const action=actionExecutionErrorInfo(value);
   if(action!==null)result.actionKind=action.kind;
   const message=field(value,'message');
   if(types.isNativeError(value)||typeof message==='string'){
    result.name??='Error';result.category=category(message);
    result.diagnostic_id=fingerprint(JSON.stringify(result)+'\0'+(typeof message==='string'?message.slice(0,4096):''));
   }
   for(const key of children){
    const nested=field(value,key);if(nested===undefined)continue;
    const captured=visit(nested,depth+1);if(captured!==undefined)result[key]=captured;
   }
   return result;
  };
  return visit(input,0);
 };
 const publish=(scope:string,args:readonly unknown[]):void=>{
  // A successful mirror poll can occur every few milliseconds. It carries no
  // failure evidence; keep only failed target rows, including their target IDs.
  let values=args;
  if(field(args[0],'kind')==='Targets'){
   const rows=field(args[0],'rows');if(Array.isArray(rows)&&!types.isProxy(rows)){
    const failures=[];for(let i=0;i<Math.min(rows.length,8);i++){const row=field(rows,String(i)),outcome=field(field(row,'finished'),'outcome');if(field(outcome,'kind')==='Failed'||field(outcome,'kind')==='TimedOut')failures.push(row);}
    if(failures.length===0)return;values=[{kind:'Targets',rows:failures}];
   }
  }
  const event=typeof values[0]==='string'?safeLabel(values[0]):undefined;
  const record={type:'runtime_diagnostic',time:new Date().toISOString(),scope,event,details:summarize([...values.slice(0,4)])};
  const line=JSON.stringify(record);write((Buffer.byteLength(line)<=16384?line:JSON.stringify({type:record.type,time:record.time,scope,event,omitted:'diagnostic_budget'}))+'\n');
 };
 const report=(...args:unknown[]):void=>publish('runtime',args);
 const forScope=(scope:string)=>{if(safeLabel(scope)!==scope)throw new TypeError('Expected diagnostic scope');return (...args:unknown[]):void=>publish(scope,args);};
 const render=(error:unknown):string=>{
  const captured=summarize(error) as Record<string,unknown>|undefined;
  publish('render',[error]);
  const code=captured?.category??'OperationFailure',id=captured?.diagnostic_id??fingerprint(JSON.stringify(captured)??'unknown');
  return `runtime operation failed: ${code} [diagnostic=${id}]`;
 };
 return Object.freeze({report,forScope,render});
}
