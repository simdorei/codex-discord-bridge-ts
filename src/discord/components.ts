import {createHash,type Hash} from "node:crypto";
import {types} from "node:util";
import {requireDiscordText} from "./text.ts";
export type BusyAction="Steer"|"Queue"|"Stop"|"Ignore";
export type ApprovalAnswer="Approve"|"ApproveSession"|"Reject"|"Cancel";
export type ComponentId=
 |{Busy:{choice_id:string;action:BusyAction}}
 |{Approval:{thread_id:string;answer:ApprovalAnswer}}
 |{BoundApproval:{thread_fingerprint:string;request_fingerprint:string;answer:ApprovalAnswer}}
 |{Input:{thread_id:string;value:string}}
 |{BoundInput:{thread_fingerprint:string;request_fingerprint:string;value:string}}
 |{AsyncChoice:{question_id:string;option:bigint}}
 |{RecoveryPublicationDecision:{proposal_id:string;revision:bigint;decision:"ApproveExact"|"KeepHeld"}}
 |{RecoveryAbandonDecision:{proposal_id:string;revision:bigint;decision:"AbandonOnly"|"KeepHeld"}};
export class ComponentError extends Error{readonly kind:"TooLong"|"Invalid";constructor(kind:"TooLong"|"Invalid"){super(kind==="TooLong"?"Discord component custom ID exceeds 100 characters":"Discord component value is invalid");this.name="ComponentError";this.kind=kind;}}
const trim=(s:string)=>s.replace(/^\p{White_Space}+/u,"").replace(/\p{White_Space}+$/u,"");
function take(s:string,n:number):string{let result="",i=0;for(const c of s){if(i++>=n)break;result+=c;}return result;}
function count(s:string):number{let n=0;for(const _ of s)n++;return n;}
const fingerprint=(s:string,n:number)=>s.length===n&&/^[0-9a-f]+$/.test(s);
const safeInput=(s:string)=>s.length>=1&&s.length<=20&&/^[A-Za-z0-9_.-]+$/.test(s);
const invalid:()=>never=()=>{throw new ComponentError("Invalid");};
function bounded(s:string):string{if(count(s)>100)throw new ComponentError("TooLong");return s;}
const approvals=new Map<string,ApprovalAnswer>([["1","Approve"],["2","ApproveSession"],["3","Reject"],["cancel","Cancel"]]);
const actions=new Map<string,BusyAction>([["steer","Steer"],["queue","Queue"],["stop","Stop"],["ignore","Ignore"]]);
export function parseComponentId(value:string):ComponentId|null{
  requireDiscordText(value);if(count(value)>100)return null;const p=value.split(":"),[prefix,a,b,c,d]=p;
  if((prefix==="codex_pub"||prefix==="codex_discard")&&p.length===5&&a==="v1"&&fingerprint(b!,32)&&/^[1-9][0-9]*$/.test(c!)){
    const revision=BigInt(c!);if(revision>(1n<<63n)-1n||revision.toString()!==c||(d!=="a"&&d!=="h"))return null;
    return prefix==="codex_pub"?{RecoveryPublicationDecision:{proposal_id:b!,revision,decision:d==="a"?"ApproveExact":"KeepHeld"}}:{RecoveryAbandonDecision:{proposal_id:b!,revision,decision:d==="a"?"AbandonOnly":"KeepHeld"}};
  }
  if(prefix==="codex_async"&&p.length===3&&fingerprint(a!,64)){const index=Number(b);if(Number.isInteger(index)&&index>=0&&index<25&&index.toString()===b)return {AsyncChoice:{question_id:a!,option:BigInt(index)}};return null;}
  if(prefix==="codex_busy"&&p.length===3&&fingerprint(a!,24)){const action=actions.get(trim(b!));return action?{Busy:{choice_id:a!,action}}:null;}
  if(prefix==="codex_approval"&&p.length===3&&trim(a!)!==""){const answer=approvals.get(trim(b!));return answer?{Approval:{thread_id:trim(a!),answer}}:null;}
  if(prefix==="codex_approval"&&p.length===5&&a==="v2"&&fingerprint(b!,16)&&fingerprint(c!,32)){const answer=approvals.get(d!);return answer?{BoundApproval:{thread_fingerprint:b!,request_fingerprint:c!,answer}}:null;}
  if(prefix==="codex_input"&&p.length===3&&trim(a!)!==""&&safeInput(trim(b!)))return {Input:{thread_id:trim(a!),value:trim(b!)}};
  if(prefix==="codex_input"&&p.length===5&&a==="v2"&&fingerprint(b!,16)&&fingerprint(c!,32)&&safeInput(d!))return {BoundInput:{thread_fingerprint:b!,request_fingerprint:c!,value:d!}};
  return null;
}
function u64(value:bigint):Buffer{if(typeof value!=="bigint"||value<0n||value>=(1n<<64n))throw new RangeError("Expected u64 identity");const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(value);return bytes;}
function field(hash:Hash,value:string):void{requireDiscordText(value);const bytes=Buffer.from(value);hash.update(u64(BigInt(bytes.length)));hash.update(bytes);}
export function threadFingerprint(thread:string):string{requireDiscordText(thread);thread=trim(thread);if(thread==="")invalid();const hash=createHash("sha256").update("cdr-discord/component-thread/v2");field(hash,thread);return hash.digest().subarray(0,8).toString("hex");}
export function requestFingerprint(generation:bigint,occurrence:Uint8Array,requestId:string|bigint):string{
  if(!(occurrence instanceof Uint8Array)||occurrence.length!==16)throw new TypeError("Expected 16-byte request occurrence");
  const hash=createHash("sha256").update("cdr-discord/component-request-binding/v3").update("\0generation").update(u64(generation)).update("\0occurrence").update(occurrence);
  if(typeof requestId==="string"){hash.update("\0request-string");field(hash,requestId);}else{if(typeof requestId!=="bigint"||requestId<-(1n<<63n)||requestId>=(1n<<63n))throw new RangeError("Expected i64 request ID");const bytes=Buffer.alloc(8);bytes.writeBigInt64BE(requestId);hash.update("\0request-integer").update(bytes);}
  return hash.digest().subarray(0,16).toString("hex");
}
export function persistentComponentClaimKey(message:bigint,component:ComponentId):string|null{
  const id=u64(message);
  if("Busy" in component||"RecoveryPublicationDecision" in component||"RecoveryAbandonDecision" in component)return null;
  if("AsyncChoice" in component)return `async-question:${message}:${component.AsyncChoice.question_id}`;
  const kind="Approval" in component||"BoundApproval" in component?"codex_approval":"codex_input";
  if("Approval" in component||"Input" in component)return createHash("sha256").update(`${kind}:${message}`).digest("hex");
  const bound="BoundApproval" in component?component.BoundApproval:component.BoundInput,hash=createHash("sha256").update("cdr-discord/component-claim/v2");field(hash,kind);hash.update(id);field(hash,bound.thread_fingerprint);field(hash,bound.request_fingerprint);return hash.digest("hex");
}
export function persistentClaimKey(message:bigint,customId:string):string|null{const parsed=parseComponentId(customId);return parsed===null?null:persistentComponentClaimKey(message,parsed);}
export function formatInputChoice(thread:string,value:string):string{requireDiscordText(thread);requireDiscordText(value);thread=trim(thread);value=trim(value);if(thread===""||!safeInput(value))invalid();return bounded(`codex_input:${thread}:${value}`);}
export interface ButtonComponent {readonly type:2;readonly custom_id:string;readonly label:string;readonly style:1|2|3|4}
export interface ActionRowComponent {readonly type:1;readonly components:readonly ButtonComponent[]}
export type DiscordComponent=ButtonComponent|ActionRowComponent;
const owned=new WeakSet<object>();
function button(label:string,customId:string,style:1|2|3|4):ButtonComponent{const value=Object.freeze({type:2 as const,custom_id:bounded(customId),label,style});owned.add(value);return value;}
function row(components:ButtonComponent[]):ActionRowComponent{const value=Object.freeze({type:1 as const,components:Object.freeze([...components])});owned.add(value);return value;}
/** This bridge's helper-produced button/row profile only, not a general Twilight component codec. */
export function serializeDiscordComponent(value:DiscordComponent):string{if(!owned.has(value))invalid();return JSON.stringify(value);}
const SERVER_PROMPT_COMPONENT_BYTES=8192;
function promptData(value:object,key:string):unknown{const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!Object.hasOwn(d,"value"))invalid();return d.value;}
function promptRecord(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(value===null||typeof value!=="object"||types.isProxy(value)||Array.isArray(value))invalid();
  const p=Object.getPrototypeOf(value),actual=Reflect.ownKeys(value);if((p!==Object.prototype&&p!==null)||actual.length!==keys.length||actual.some(k=>typeof k!=="string"||!keys.includes(k)))invalid();
  for(const key of keys)promptData(value,key);return value as Record<string,unknown>;
}
function promptArray(value:unknown,max:number):asserts value is unknown[]{
  if(value===null||typeof value!=="object"||types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)invalid();
  const length=Object.getOwnPropertyDescriptor(value,"length")?.value;if(!Number.isSafeInteger(length)||length<0||length>max||Reflect.ownKeys(value).length!==length+1)invalid();
  for(let i=0;i<length;i++)promptData(value,String(i));
}
/** Exact buildServerPrompt output profile only. This is value transfer, never a
 * component identity, occurrence, actor, response permission or admission proof. */
function serverPromptTransferProfile(input:unknown,requireOwned:boolean):readonly DiscordComponent[]{
  promptArray(input,1);if(input.length===0)return input as readonly DiscordComponent[];
  const r=promptRecord(input[0],["type","components"]);if(r.type!==1||(requireOwned&&!owned.has(r)))invalid();
  promptArray(r.components,5);if(r.components.length===0)invalid();
  let profile:"approval"|"input"|undefined,thread:string|undefined,request:string|undefined;
  for(let i=0;i<r.components.length;i++){
    const b=promptRecord(r.components[i],["type","custom_id","label","style"]);if(b.type!==2||(requireOwned&&!owned.has(b)))invalid();
    requireDiscordText(b.custom_id);requireDiscordText(b.label);
    const match=/^codex_(approval|input):v2:([0-9a-f]{16}):([0-9a-f]{32}):(1|2|3|4|5|cancel)$/.exec(b.custom_id);if(match===null)invalid();
    const kind=match[1] as "approval"|"input";if(i===0){profile=kind;thread=match[2];request=match[3];}
    if(kind!==profile||match[2]!==thread||match[3]!==request)invalid();
    if(kind==="approval"){
      const expected=APPROVALS[i];if(r.components.length!==4||expected===undefined||b.label!==expected[0]||match[4]!==expected[1]||b.style!==expected[2])invalid();
    }else{
      const scalars=count(b.label);if(b.style!==1||match[4]!==String(i+1)||scalars<1||scalars>80||/^\p{White_Space}/u.test(b.label)||(scalars<80&&/\p{White_Space}$/u.test(b.label)))invalid();
    }
  }
  return input as readonly DiscordComponent[];
}
/** Serialize only original helper-owned server-prompt rows/buttons. Duplicate
 * labels and the trim-before-truncate helper's final 80th whitespace survive. */
export function captureServerPromptComponentTransfer(input:readonly DiscordComponent[]):string{
  const components=serverPromptTransferProfile(input,true),encoded=`[${components.map(serializeDiscordComponent).join(",")}]`;
  if(Buffer.byteLength(encoded,"utf8")>SERVER_PROMPT_COMPONENT_BYTES)invalid();return encoded;
}
/** A closed reconstruction, not general component rebranding. JSON is bounded
 * before parsing; canonical round-trip rejects duplicate keys and alternate
 * encodings. Private constructors preserve already-truncated label bytes. */
export function restoreServerPromptComponentTransfer(input:string):readonly DiscordComponent[]{
  if(typeof input!=="string"||Buffer.byteLength(input,"utf8")>SERVER_PROMPT_COMPONENT_BYTES)invalid();requireDiscordText(input);
  let decoded:unknown;try{decoded=JSON.parse(input);}catch{invalid();}
  const captured=serverPromptTransferProfile(decoded,false);
  const result:readonly DiscordComponent[]=Object.freeze(captured.length===0?[]:[row((captured[0] as ActionRowComponent).components.map(b=>button(b.label,b.custom_id,b.style)))]);
  if(`[${result.map(serializeDiscordComponent).join(",")}]`!==input)invalid();return result;
}
export function busyButtonRow(choice:string,allowSteer:boolean):ActionRowComponent{
  requireDiscordText(choice);if(!fingerprint(choice,24)||typeof allowSteer!=="boolean")invalid();return row([button(allowSteer?"Steer now":"Steer (check)",`codex_busy:${choice}:steer`,1),button("Queue next",`codex_busy:${choice}:queue`,2),button("Stop reply",`codex_busy:${choice}:stop`,4),button("Ignore",`codex_busy:${choice}:ignore`,2)]);
}
/** ActionUi::ProBusy removes only the steer button from the normal busy row. */
export function proBusyButtonRow(choice:string):ActionRowComponent{
  const source=busyButtonRow(choice,false);return row(source.components.filter(component=>!component.custom_id.endsWith(":steer")));
}
const APPROVALS:readonly (readonly [string,string,1|2|3|4])[]=[["Approve","1",3],["Approve session","2",1],["Reject","3",4],["Cancel","cancel",2]];
export function approvalButtonRow(thread:string):ActionRowComponent{requireDiscordText(thread);thread=trim(thread);if(thread==="")invalid();return row(APPROVALS.map(([label,answer,style])=>button(label,`codex_approval:${thread}:${answer}`,style)));}
export function boundApprovalButtonRow(thread:string,generation:bigint,occurrence:Uint8Array,requestId:string|bigint):ActionRowComponent{const t=threadFingerprint(thread),r=requestFingerprint(generation,occurrence,requestId);return row(APPROVALS.map(([label,answer,style])=>button(label,`codex_approval:v2:${t}:${r}:${answer}`,style)));}
export function inputButtonRow(thread:string,options:readonly (readonly [string,string])[]):ActionRowComponent{if(options.length===0)invalid();return row(options.slice(0,5).map(([value,label])=>{requireDiscordText(label);label=take(trim(label),80);if(label==="")invalid();return button(label,formatInputChoice(thread,value),1);}));}
export function boundInputButtonRow(thread:string,generation:bigint,occurrence:Uint8Array,requestId:string|bigint,options:readonly (readonly [string,string])[]):ActionRowComponent{
  if(options.length===0)invalid();const t=threadFingerprint(thread),r=requestFingerprint(generation,occurrence,requestId);return row(options.slice(0,5).map(([value,label])=>{requireDiscordText(value);requireDiscordText(label);value=trim(value);label=take(trim(label),80);if(label===""||!safeInput(value))invalid();return button(label,`codex_input:v2:${t}:${r}:${value}`,1);}));
}
export function asyncChoiceRows(id:string,options:readonly string[]):ActionRowComponent[]{
  requireDiscordText(id);if(!fingerprint(id,64)||options.length<1||options.length>25)invalid();for(const option of options){requireDiscordText(option);if(trim(option)==="")invalid();}
  const buttons=options.map((option,index)=>{let label=`${index+1}. ${option}`;if(count(label)>80)label=take(label,79)+"…";return button(label,`codex_async:${id}:${index}`,1);});const rows:ActionRowComponent[]=[];for(let i=0;i<buttons.length;i+=5)rows.push(row(buttons.slice(i,i+5)));return rows;
}
function decisionRows(id:string,revision:bigint,abandon:boolean):ActionRowComponent[]{requireDiscordText(id);if(!fingerprint(id,32)||typeof revision!=="bigint"||revision<=0n||revision>=(1n<<63n))invalid();const prefix=abandon?"codex_discard":"codex_pub";return [row([button(abandon?"Abandon saved request only":"Approve exact recovery intent",`${prefix}:v1:${id}:${revision}:a`,abandon?4:1),button(abandon?"Keep held":"Keep recovery held",`${prefix}:v1:${id}:${revision}:h`,2)])];}
export function publicationDecisionRows(id:string,revision:bigint):ActionRowComponent[]{return decisionRows(id,revision,false);}
export function abandonmentDecisionRows(id:string,revision:bigint):ActionRowComponent[]{return decisionRows(id,revision,true);}
export function deferredUpdate():{readonly type:6}{return Object.freeze({type:6});}
