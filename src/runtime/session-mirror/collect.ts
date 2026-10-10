import {createHash} from 'node:crypto';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {rustTrim,serdeField,serdeObject} from '../../app-server/value.ts';
import {requireDiscordText} from '../../discord/text.ts';

export type MirrorDetail='Send'|'All';
export type MirrorKind='User'|'Commentary'|'Final'|'Aborted'|'Failed';
export interface MirrorItem {readonly digest:string;readonly kind:MirrorKind;readonly phase:string;readonly text:string;readonly turnId:string|null;readonly dedupeRecentText:boolean;}
export interface MirrorCollection {readonly items:readonly MirrorItem[];readonly currentTurn:string|null;}
const string=(v:unknown,k:string):string=>{const x=serdeField(v,k);return typeof x==='string'?x:'';};
const digest=(...parts:string[]):string=>{const h=createHash('sha256');for(const p of parts){h.update(p,'utf8');h.update('\0');}return h.digest('hex');};
const internalPrefixes=['# AGENTS.md instructions','<INSTRUCTIONS>','<environment_context','<codex_internal_context'];

function eventDigest(thread:string,event:unknown,kind:MirrorKind,phase:string,text:string):string{
  const time=string(event,'timestamp');
  if(kind==='User')return digest('session-mirror',thread,time,'user',text);
  return digest('session-mirror',thread,time,string(event,'type'),string(serdeField(event,'payload'),'type'),kind.toLowerCase(),'assistant',phase,text);
}
function messageText(payload:unknown):string{
  const parts=serdeField(payload,'content');if(!Array.isArray(parts))return '';
  return rustTrim(parts.filter(p=>['input_text','output_text'].includes(string(p,'type'))).map(p=>string(p,'text')).filter(t=>t!=='').join('\n'));
}
function visibleTexts(value:unknown):string[]{
  if(typeof value==='string')return value===''?[]:[value];
  if(Array.isArray(value))return value.map(p=>{const t=serdeField(p,'text');return typeof t==='string'?t:typeof p==='string'?p:'';}).filter(t=>t!=='');
  return value===undefined||value===null?[]:[serializeSerdeValue(value)];
}
/** Peels only the same four known envelopes as Rust error_message::readable_error. */
function readableError(raw:string):string{
  let text=rustTrim(raw);
  for(let i=0;i<4;i++){
    let value:unknown;try{value=parseSerdeValue(text);}catch{break;}
    const nested=serdeField(serdeField(value,'error'),'message');
    const direct=serdeField(value,'message');
    const message=nested!==undefined?nested:direct!==undefined?direct:typeof value==='string'?value:undefined;
    if(typeof message!=='string'||rustTrim(message)===''||message===text)break;
    text=message;
  }
  return text;
}

/** Pure decoded-event transform only. Caller owns file-generation, byte/record budgets,
 * worker isolation and delivery-before-cursor commit; this function performs no I/O. */
export function collectSessionItems(thread:string,input:unknown,detail:MirrorDetail,currentTurn:string|null=null):MirrorCollection{
  requireDiscordText(thread);if(currentTurn!==null)requireDiscordText(currentTurn);
  if(detail!=='Send'&&detail!=='All')throw new TypeError('Expected mirror detail');
  const events=cloneOwnedSerdeValue(input);
  if(!Array.isArray(events)||!events.every(serdeObject))throw new TypeError('Expected decoded session event objects');
  const items:MirrorItem[]=[],seen=new Set<string>(),terminalTurns=new Set<string>();
  for(const event of events){
    const payload=serdeField(event,'payload'),eventType=string(event,'type'),payloadType=string(payload,'type');
    if(eventType==='turn_context'||payloadType==='task_started'){const turn=string(payload,'turn_id');if(turn!=='')currentTurn=turn;}
    if(!serdeObject(payload))continue;
    const append=(kind:MirrorKind,phase:string,raw:string,turn:string|null=null,activityIndex:number|null=null):void=>{
      const text=rustTrim(raw);if(text==='')return;
      if(turn==='')turn=null;
      let id=turn!==null&&['Final','Failed','Aborted'].includes(kind)?digest('session-terminal-v2',thread,turn):eventDigest(thread,event,kind,phase,text);
      if(activityIndex!==null)id=digest(id,raw,String(activityIndex));
      if(turn===null&&currentTurn!==null){turn=currentTurn;id=digest('session-turn-event-v1',turn,id);}
      if(seen.has(id))return;seen.add(id);
      items.push(Object.freeze({digest:id,kind,phase,text:activityIndex===null?text:raw,turnId:turn,dedupeRecentText:kind==='Commentary'&&activityIndex===null}));
    };
    const user=(text:string,phase:string):void=>{if(!internalPrefixes.some(p=>text.replace(/^\p{White_Space}+/u,'').startsWith(p)))append('User',phase,text);};
    if(eventType==='event_msg'){
      if(payloadType==='agent_message'){const phase=string(payload,'phase')||'commentary';if(phase!=='final_answer')append('Commentary',phase,string(payload,'message'));}
      else if(payloadType==='user_message')user(string(payload,'message'),'input');
      else if(['task_complete','turn_aborted','task_aborted','task_cancelled'].includes(payloadType)){
        const turn=string(payload,'turn_id');if(turn!==''&&terminalTurns.has(turn))continue;if(turn!=='')terminalTurns.add(turn);
        if(payloadType==='task_complete'){
          const error=serdeField(payload,'error');
          if(error!==undefined&&error!==null){const m=serdeField(error,'message');append('Failed','error',readableError(typeof m==='string'?m:serializeSerdeValue(error)),turn);}
          else append('Final','final_answer',string(payload,'last_agent_message')||'Codex turn completed without a visible reply.',turn);
        }else append('Aborted',payloadType,payloadType==='task_cancelled'?'Codex task cancelled.':payloadType==='task_aborted'?'Codex task aborted.':'Codex turn aborted.',turn);
      }
    }else if(eventType==='response_item'){
      if(payloadType==='message'){
        const role=string(payload,'role'),phase=string(payload,'phase'),text=messageText(payload);
        if(role==='assistant'&&phase==='commentary')append('Commentary',phase,text);else if(role==='user')user(text,phase);
      }else if(detail==='All'){
        if(payloadType==='reasoning')visibleTexts(serdeField(payload,'summary')).forEach((t,i)=>append('Commentary','reasoning',t,null,i));
        else if(payloadType==='function_call'||payloadType==='custom_tool_call'){const name=string(payload,'name');append('Commentary','tool_call',name===''?'Tool call':`Tool call: ${name}`,null,0);}
        else if(payloadType==='function_call_output'||payloadType==='custom_tool_call_output')visibleTexts(serdeField(payload,'output')).forEach((t,i)=>append('Commentary','tool_output',`Tool output:\n${t}`,null,i));
      }
    }
  }
  return Object.freeze({items:Object.freeze(items),currentTurn});
}

export function formatMirrorItem(item:MirrorItem):string{
  switch(item.kind){case 'User':return `Codex app user\n\n${item.text}`;case 'Commentary':return `In progress\n\n${item.text}`;case 'Final':return `Final\n\n${item.text}`;case 'Failed':return `Failed\n\n${item.text}`;case 'Aborted':return item.text;}
}
