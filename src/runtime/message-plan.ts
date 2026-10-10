import {types} from 'node:util';
import {gatewayOwnField} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {rustTrim} from '../app-server/value.ts';
import {isEmergencyMessage} from '../discord/gateway/routing.ts';
import {planPrefix,PrefixPlanError,type PrefixAction} from './prefix-plan.ts';
import type {CommandAction} from './command-plan.ts';
export interface IncomingMessage {
 readonly content:string;readonly messageContentEnabled:boolean;readonly channelAllowed:boolean;readonly userAllowed:boolean;
 readonly authorIsBot:boolean;readonly authorIsSelf:boolean;readonly authorMentionsBridge:boolean;readonly hasAttachments:boolean;readonly mirroredTarget:boolean;
 /** Arrays represent Rust BTreeSet values; duplicates are removed, sorted as u64. */
 readonly mentionedUserIds:readonly bigint[];readonly requiredPlainAskUserIds:readonly bigint[];
}
export type MessagePlan={readonly Ignore:string}|{readonly Respond:string}|{readonly Execute:CommandAction};
export class MessagePlanError extends Error {
 readonly kind:'Prefix'|'UnsupportedPrefix';readonly source:PrefixPlanError|string;
 constructor(kind:'Prefix'|'UnsupportedPrefix',source:PrefixPlanError|string){super(kind==='Prefix'?(source as PrefixPlanError).message:`prefix command is parsed but not implemented yet: !${source}`,{cause:source});this.name='MessagePlanError';this.kind=kind;this.source=source;Object.freeze(this);}
}
function ids(value:unknown):readonly bigint[]{
 if(!Array.isArray(value)||types.isProxy(value))throw new TypeError('Expected u64 ID set array');const out:bigint[]=[];
 for(let i=0;i<value.length;i++){const n=gatewayOwnField(value,String(i));if(typeof n!=='bigint'||n<0n||n>=1n<<64n)throw new TypeError('Expected u64 ID');out.push(n);}
 return Object.freeze([...new Set(out)].sort((a,b)=>a<b?-1:a>b?1:0));
}
function converted(action:PrefixAction):CommandAction {
 if(action==='DiscoverCodex')return 'Doctor';if(action==='MirrorSync')return Object.freeze({BridgeSync:Object.freeze({limit:null})});
 if(typeof action==='string')return action;
 if('List' in action)return Object.freeze({List:Object.freeze({limit:action.List.limit===0n?10n:action.List.limit})});
 if('MirrorList' in action)return Object.freeze({MirrorInspect:Object.freeze({limit:action.MirrorList.limit,list:true})});
 if('MirrorCheck' in action)return Object.freeze({MirrorInspect:Object.freeze({limit:action.MirrorCheck.limit,list:false})});
 if('MirrorDetail' in action)throw new MessagePlanError('UnsupportedPrefix','detail');
 if('SkillPrompt' in action){const {kind,request}=action.SkillPrompt;
  return kind==='Interview'?Object.freeze({Interview:Object.freeze({prompt:request})}):Object.freeze({Ask:Object.freeze({prompt:kind==='Pro'?`!pro ${request}`:`Use $archive-used with this threshold:\n\n${request}`})});
 }
 return action;
}
/** Pure authenticated-message policy gate and command description. Not an ingress
 * admission, executable permit or delivery operation. Bot and mention facts must
 * come from the authenticated Discord decoder/policy boundary. */
export function planMessage(input:IncomingMessage):MessagePlan {
 const content=gatewayOwnField(input,'content');requireDiscordText(content);
 const flag=(key:string)=>{const v=gatewayOwnField(input,key);if(typeof v!=='boolean')throw new TypeError('Expected message policy boolean');return v;};
 const enabled=flag('messageContentEnabled'),channel=flag('channelAllowed'),user=flag('userAllowed'),bot=flag('authorIsBot'),self=flag('authorIsSelf'),bridgeMention=flag('authorMentionsBridge'),attachments=flag('hasAttachments'),mirrored=flag('mirroredTarget');
 const mentions=ids(gatewayOwnField(input,'mentionedUserIds')),required=ids(gatewayOwnField(input,'requiredPlainAskUserIds'));
 const ignore=(reason:string):MessagePlan=>Object.freeze({Ignore:reason});
 if(!enabled)return ignore('message_content_disabled');if(!channel)return ignore('channel_not_allowed');if(!user)return ignore('user_not_allowed');if(self)return ignore('self_authored');
 if(bot&&!bridgeMention)return ignore('bot_author_without_bridge_mention');
 const trimmed=rustTrim(content);if(bot&&isEmergencyMessage(trimmed))return ignore('force_restart_requires_human');
 if(trimmed.startsWith('!')){
  let action:CommandAction;try{action=converted(planPrefix(trimmed.slice(1)));}catch(e){if(e instanceof PrefixPlanError)throw new MessagePlanError('Prefix',e);throw e;}
  if(bot&&typeof action==='object'&&'DiscardRequest' in action)return ignore('discard_request_requires_human');return Object.freeze({Execute:action});
 }
 let prompt=trimmed;
 if(!mirrored&&required.length!==0){if(!mentions.some(id=>required.includes(id)))return ignore('required_mention_missing');
  for(const id of required){prompt=prompt.replaceAll(`<@${id}>`,'').replaceAll(`<@!${id}>`,'');}prompt=rustTrim(prompt);
  if(prompt===''&&!attachments)return Object.freeze({Respond:'Add a prompt after the mention.'});
 }
 if(prompt===''){if(!attachments)return ignore('empty_content');prompt='Please inspect the attached Discord file(s).';}
 return Object.freeze({Execute:Object.freeze({Ask:Object.freeze({prompt})})});
}
