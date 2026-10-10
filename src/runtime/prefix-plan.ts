import {rustTrim} from '../app-server/value.ts';
import {asciiLower} from '../config/remote.ts';
import {requireDiscordText} from '../discord/text.ts';
import {isForceRestartMessage} from '../discord/gateway/routing.ts';
import {AUTO_RESERVE_REMOVED} from '../discord/interaction-routing.ts';
import {isRustUuidText} from '../core/rust-uuid-text.ts';
export type MirrorDetailMode='Send'|'All';
export type SkillPromptKind='Pro'|'Interview'|'ArchiveUsed';
type Ref={readonly reference:string};type OptionalRef={readonly reference:string|null};
type Tagged<T> = {[K in keyof T]: Readonly<{[P in K]:Readonly<T[K]>}>}[keyof T];
export type PrefixAction='Help'|'DiscoverCodex'|'RestartCodex'|'ForceRestartCodex'|'Doctor'|'Identity'|'Where'|'Runners'|'Resources'|'MirrorSync'|'Approval'|'QaButtons'|'HostReboot'
 |Tagged<{List:{limit:bigint};ArchivedList:{limit:bigint};Use:Ref;Open:{reference:string;abort:boolean};Status:OptionalRef;Stop:OptionalRef;Recover:OptionalRef;Repair:OptionalRef;Archive:OptionalRef;Resume:OptionalRef;Retract:OptionalRef;
 Settings:{reference:string|null;model:string|null;effort:string|null;speed:string|null};AutoReserve:{reference:string|null;enabled:boolean};SettingsOptions:{reference:string|null;field:string|null};
 DeleteArchivePreview:Ref;DeleteArchiveConfirm:Ref;Context:{all_threads:boolean;refresh:boolean;limit:bigint};Usage:{days:bigint};SavedRequest:{request_id:string};DiscardRequest:{job_id:string};
 BridgeSync:{limit:bigint|null};MirrorList:{limit:bigint|null};MirrorCheck:{limit:bigint|null};MirrorDetail:{mode:MirrorDetailMode|null};New:{prompt:string};Steer:{prompt:string};SkillPrompt:{kind:SkillPromptKind;request:string}}>;
export class PrefixPlanError extends Error {
 readonly kind:'Usage'|'Unknown';readonly value:string;
 constructor(kind:'Usage'|'Unknown',value:string){super(kind==='Usage'?value:`unknown prefix command: !${value}`);this.name='PrefixPlanError';this.kind=kind;this.value=value;Object.freeze(this);}
}
const usage=(text:string):never=>{throw new PrefixPlanError('Usage',text);};
const optional=(s:string)=>s===''?null:s;
const required=(s:string,message:string)=>optional(s)??usage(message);
const words=(s:string)=>rustTrim(s)===''?[]:rustTrim(s).split(/\p{White_Space}+/u);
function split(s:string):[string,string]{const match=/\p{White_Space}/u.exec(s);return match===null?[s,'']:[s.slice(0,match.index),s.slice(match.index+match[0].length)];}
function integer(s:string):bigint|null{if(!/^[+-]?[0-9]+$/u.test(s))return null;const n=BigInt(s);return n>=-(1n<<63n)&&n<1n<<63n?n:null;}
const clamp=(n:bigint,max:bigint)=>n<1n?1n:n>max?max:n;
function bounded(s:string,fallback:bigint,max:bigint){const n=integer(s);return n===null?fallback:clamp(n,max);}
function requiredBounded(s:string,fallback:bigint,max:bigint,message:string){if(s==='')return fallback;const n=integer(s);return n===null?usage(message):clamp(n,max);}
function own<T extends Exclude<PrefixAction,string>>(value:T):T{for(const v of Object.values(value))Object.freeze(v);return Object.freeze(value);}
const SETTINGS_USAGE='Usage: !settings [ref] [--model <model>] [--reasoning <effort>] [--effort <effort>] [--speed <speed>]';
function shellWords(raw:string):string[]{const output:string[]=[];let current='',quote:string|null=null,escaped=false,started=false;
 for(const ch of raw){
  if(escaped){current+=ch;started=true;escaped=false;}
  else if(ch==='\\'&&quote!=="'"){escaped=true;}
  else if(ch==="'"||ch==='"'){started=true;if(quote===ch)quote=null;else if(quote===null)quote=ch;else current+=ch;}
  else if(/\p{White_Space}/u.test(ch)&&quote===null){if(started){output.push(current);current='';started=false;}}
  else{started=true;current+=ch;}
 }
 if(escaped||quote!==null)usage(SETTINGS_USAGE+'\nERROR: No closing quotation');if(started)output.push(current);return output;
}
function settings(arg:string):PrefixAction{
 const tokens=shellWords(arg);if(tokens.some(t=>t==='--auto-reserve'||t.startsWith('--auto-reserve=')))usage(AUTO_RESERVE_REMOVED);
 let reference:string|null=null,optionQuery:string|null=null;const values:{model:string|null;effort:string|null;speed:string|null}={model:null,effort:null,speed:null};
 for(let i=0;i<tokens.length;){const token=tokens[i]!;const field=token==='--model'?'model':token==='--effort'||token==='--reasoning'?'effort':token==='--speed'?'speed':null;
  if(field!==null){if(values[field]!==null||optionQuery!==null)usage(SETTINGS_USAGE);const next=tokens[i+1];if(next===undefined||next.startsWith('--')){optionQuery=field;i++;continue;}if(rustTrim(next)==='')usage(SETTINGS_USAGE);values[field]=next;i+=2;continue;}
  if(rustTrim(token)===''||token.startsWith('--')||reference!==null)usage(SETTINGS_USAGE);reference=token;i++;
 }
 if(optionQuery!==null){if(Object.values(values).some(v=>v!==null))usage(SETTINGS_USAGE);return own({SettingsOptions:{reference,field:optionQuery}});}
 return own({Settings:{reference,...values}});
}
/** Pure source-backed legacy command parser. Input excludes the leading '!'.
 * Returns descriptions only; no host restart, native action, queue or DB access. */
export function planPrefix(commandLine:string):PrefixAction{
 requireDiscordText(commandLine);const [raw,argRaw]=split(commandLine.replace(/^\p{White_Space}+/u,'')),command=rustTrim(raw).toLowerCase(),arg=rustTrim(argRaw);
 switch(command){
  case '':case 'help':case 'start':return 'Help';
  case 'list':return own({List:{limit:arg===''?0n:bounded(arg,10n,30n)}});
  case 'archived_list':case 'archive_list':return own({ArchivedList:{limit:bounded(arg,10n,50n)}});
  case 'use':return own({Use:{reference:required(arg,'Usage: !use <ref>')}});
  case 'open':case 'open_abort':return own({Open:{reference:required(arg,`Usage: !${command} <ref>`),abort:command==='open_abort'}});
  case 'status':return own({Status:{reference:optional(arg)}});
  case 'stop':return own({Stop:{reference:optional(arg)}});
  case 'recover':case '복구':if(words(arg).length>1)usage('Usage: !recover [ref]');return own({Recover:{reference:optional(arg)}});
  case 'repair':case '도구복구':if(words(arg).length>1)usage('Usage: !repair [ref]');return own({Repair:{reference:optional(arg)}});
  case 'settings':case 'setting':return settings(arg);
  case 'discover_codex':return 'DiscoverCodex';
  case 'restart_codex':if(arg==='')return 'RestartCodex';
  case 'force_restart':if(isForceRestartMessage('!'+commandLine))return 'ForceRestartCodex';return usage('Usage: !restart_codex [force] or !force_restart');
  case 'archive':return own({Archive:{reference:optional(arg)}});
  case 'delete_archive':return own({DeleteArchivePreview:{reference:required(arg,'Usage: !delete_archive <ref>')}});
  case 'confirm_delete_archive':return own({DeleteArchiveConfirm:{reference:required(arg,'Usage: !confirm_delete_archive <ref>')}});
  case 'doctor':return 'Doctor';
  case 'resume':return own({Resume:{reference:optional(arg)}});
  case 'chatid':case 'whoami':return 'Identity';case 'where':case 'map':return 'Where';
  case 'context':case 'ctx':{
   const w=words(arg.toLowerCase());if(w[0]==='refresh'||w[0]==='recent'){if(w.length>2)usage('Usage: !context [all | refresh [limit]]');return own({Context:{all_threads:false,refresh:true,limit:requiredBounded(w[1]??'',10n,30n,'Usage: !context refresh [integer limit]')}});}
   const all=arg.toLowerCase()==='all'||arg==='*';if(w.length!==0&&!all)usage('Usage: !context [all | refresh [limit]]');return own({Context:{all_threads:all,refresh:false,limit:all?20n:10n}});
  }
  case 'usage':case 'quota':case 'limit':return own({Usage:{days:requiredBounded(arg,7n,30n,'Usage: !usage [days]')}});
  case 'runners':case 'queues':if(arg==='')return 'Runners';if(/\p{White_Space}/u.test(arg))usage('Usage: !runners [request_id]');return own({SavedRequest:{request_id:arg}});
  case 'discard-request':if(words(commandLine)[0]!=='discard-request'||arg.length!==36||arg.toLowerCase()!==arg||!isRustUuidText(arg))usage('Usage: !discard-request <exact canonical job UUID>');return own({DiscardRequest:{job_id:arg}});
  case 'resources':case 'system':return 'Resources';case 'retract':case 'unqueue':return own({Retract:{reference:optional(arg)}});
  case 'bridge_sync':case 'resync':case 'sync':case 'bridge':{
   let value=arg;if(command==='bridge'){const [sub,tail]=split(arg);if(sub!==''&&asciiLower(sub)!=='sync')usage('Usage: !bridge sync [limit]');value=rustTrim(tail);}
   return own({BridgeSync:{limit:value===''?null:requiredBounded(value,1n,100n,'Usage: !bridge sync [limit]')}});
  }
  case 'mirror':{
   const [sub,tail]=split(arg),name=sub.toLowerCase(),value=rustTrim(tail);if((name===''||name==='sync')&&value==='')return 'MirrorSync';
   if(name==='list'||name==='check'||name==='doctor'){const kind=name==='list'?'list':'check',limit=value===''?null:requiredBounded(value,1n,100n,`Usage: !mirror ${kind} [limit]`);return name==='list'?own({MirrorList:{limit}}):own({MirrorCheck:{limit}});}
   return usage('Usage: !mirror sync | !mirror list [limit] | !mirror check [limit]');
  }
  case 'detail':{const lower=arg.toLowerCase();if(lower!==''&&lower!=='send'&&lower!=='all')usage('Usage: !detail | !detail send | !detail all');return own({MirrorDetail:{mode:lower===''?null:lower==='send'?'Send':'All'}});}
  case 'approval':case 'approve':return 'Approval';case 'new':return own({New:{prompt:arg}});case 'steer':return own({Steer:{prompt:required(arg,'Usage: !steer <prompt>')}});
  case 'qa':if(arg===''||['button','buttons'].includes(arg.toLowerCase()))return 'QaButtons';return usage('Usage: !qa buttons');
  case 'pro':case 'interview':case 'deep_interview':case 'deep-interview':case 'archive-used':return own({SkillPrompt:{kind:command==='pro'?'Pro':command==='archive-used'?'ArchiveUsed':'Interview',request:required(arg,`Usage: !${command} <${command==='archive-used'?'threshold':'request'}>`)}});
  case 'reset_pc':case 'reboot_pc':case 'reset_computer':if(asciiLower(arg)==='confirm')return 'HostReboot';return usage('Usage: !reset_pc confirm');
  default:throw new PrefixPlanError('Unknown',command);
 }
}
