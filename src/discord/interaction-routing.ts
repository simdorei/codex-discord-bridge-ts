import {slashCommands} from './commands.ts';
import {parseComponentId,type ComponentId} from './components.ts';
import {isDecodedGatewayInteraction,type DecodedGatewayInteraction} from './gateway/decoded-interaction.ts';
import {requireDiscordText} from './text.ts';
export const AUTO_RESERVE_REMOVED='자동 Reserve 전환 기능은 제거되었습니다. 설정은 변경하지 않았습니다. 필요하면 !settings --model gpt-reserve 로 직접 선택하세요.';
export type SlashValue={readonly Boolean:boolean}|{readonly Integer:bigint}|{readonly String:string};
export interface SlashInvocation{readonly name:string;readonly values:Readonly<Record<string,SlashValue>>}
export interface AutocompleteInvocation{readonly command_name:string;readonly option_name:string;readonly current:string;readonly selected_model:string|null}
export type RoutedInteractionWork={readonly Slash:SlashInvocation}|{readonly Autocomplete:AutocompleteInvocation}|{readonly Component:ComponentId};
export type RoutedInitialResponse={readonly type:5|6}|{readonly type:8;readonly data:{readonly choices:readonly []}};
export interface InteractionWorkRoute{readonly initialResponse:RoutedInitialResponse;readonly work:RoutedInteractionWork}
export type InteractionRouteErrorKind='RemovedFeature'|'WrongInteractionType'|'WrongCommandType'|'UnknownCommand'|'InvalidOption'|'DuplicateOption'|'MissingOption'|'MissingFocusedOption'|'UnknownComponent';
export class InteractionRouteError extends Error{readonly kind:InteractionRouteErrorKind;readonly command:string;readonly option:string;constructor(kind:InteractionRouteErrorKind,command='',option=''){
 const messages={RemovedFeature:AUTO_RESERVE_REMOVED,WrongInteractionType:'unsupported Discord interaction type',WrongCommandType:'only slash commands are supported',UnknownCommand:`unknown Discord slash command: ${command}`,InvalidOption:`unknown or invalid option ${option} for slash command ${command}`,DuplicateOption:`duplicate option ${option} for slash command ${command}`,MissingOption:`required option ${option} is missing for slash command ${command}`,MissingFocusedOption:'autocomplete interaction has no valid focused option',UnknownComponent:'Discord component custom ID is unknown or invalid'};
 super(messages[kind]);this.name='InteractionRouteError';this.kind=kind;this.command=command;this.option=option;
}}
const invocations=new WeakSet<object>();
function value(invocation:SlashInvocation,name:string):SlashValue|undefined{if(!invocations.has(invocation))throw new TypeError('Expected routed slash invocation');requireDiscordText(name);return Object.hasOwn(invocation.values,name)?invocation.values[name]:undefined;}
export function slashHasOption(invocation:SlashInvocation,name:string):boolean{return value(invocation,name)!==undefined;}
export function slashString(invocation:SlashInvocation,name:string):string|null{const v=value(invocation,name);return v!==undefined&&'String'in v?v.String:null;}
export function slashInteger(invocation:SlashInvocation,name:string):bigint|null{const v=value(invocation,name);return v!==undefined&&'Integer'in v?v.Integer:null;}
export function slashBoolean(invocation:SlashInvocation,name:string):boolean|null{const v=value(invocation,name);return v!==undefined&&'Boolean'in v?v.Boolean:null;}
interface Option{name:string;type:bigint;kind:string;value:unknown}
/** Pure routing after complete decoder ownership. This is neither access policy
 * nor execution/admission. Values use source external-tagged enum shapes, with
 * BTreeMap-compatible sorted known ASCII option names and lossless i64 integers. */
export function routeGatewayCommand(interaction:DecodedGatewayInteraction,qa:boolean):InteractionWorkRoute{
 if(!isDecodedGatewayInteraction(interaction))throw new TypeError('Expected fully decoded interaction');if(interaction.type!==2n&&interaction.type!==4n)throw new InteractionRouteError('WrongInteractionType');
 const data=interaction.data as {name:string;type:bigint;options:readonly Option[]};if(data.type!==1n)throw new InteractionRouteError('WrongCommandType');if(data.name==='settings'&&data.options.some(o=>o.name==='auto_reserve'))throw new InteractionRouteError('RemovedFeature');
 const schema=slashCommands(qa).find(command=>command.name===data.name);if(schema===undefined)throw new InteractionRouteError('UnknownCommand',data.name);const autocomplete=interaction.type===4n,seen=new Set<string>(),values=new Map<string,SlashValue>();let focused:{name:string;current:string}|null=null;
 for(const option of data.options){if(seen.has(option.name))throw new InteractionRouteError('DuplicateOption',data.name,option.name);seen.add(option.name);const expected=schema.options.find(x=>x.name===option.name);if(expected===undefined)throw new InteractionRouteError('InvalidOption',data.name,option.name);
  if(option.kind==='Focused'){if(!autocomplete||expected.autocomplete!==true||BigInt(expected.type)!==option.type)throw new InteractionRouteError('InvalidOption',data.name,option.name);if(focused!==null)throw new InteractionRouteError('MissingFocusedOption');focused={name:option.name,current:option.value as string};}
  else{let selected:SlashValue;if(option.kind==='Boolean')selected=Object.freeze({Boolean:option.value as boolean});else if(option.kind==='Integer')selected=Object.freeze({Integer:option.value as bigint});else if(option.kind==='String')selected=Object.freeze({String:option.value as string});else throw new InteractionRouteError('InvalidOption',data.name,option.name);if(BigInt(expected.type)!==option.type)throw new InteractionRouteError('InvalidOption',data.name,option.name);values.set(option.name,selected);}
 }
 for(const option of schema.options)if(option.required===true&&!seen.has(option.name))throw new InteractionRouteError('MissingOption',data.name,option.name);
 if(autocomplete){if(focused===null)throw new InteractionRouteError('MissingFocusedOption');const model=values.get('model');return Object.freeze({initialResponse:Object.freeze({type:8 as const,data:Object.freeze({choices:Object.freeze([]) as readonly []})}),work:Object.freeze({Autocomplete:Object.freeze({command_name:data.name,option_name:focused.name,current:focused.current,selected_model:model!==undefined&&'String'in model?model.String:null})})});}
 const ordered:Record<string,SlashValue>=Object.create(null);for(const key of [...values.keys()].sort())ordered[key]=values.get(key)!;Object.freeze(ordered);const invocation=Object.freeze({name:data.name,values:ordered});invocations.add(invocation);return Object.freeze({initialResponse:Object.freeze({type:5 as const}),work:Object.freeze({Slash:invocation})});
}
export function routeGatewayComponent(interaction:DecodedGatewayInteraction):InteractionWorkRoute{if(!isDecodedGatewayInteraction(interaction))throw new TypeError('Expected fully decoded interaction');if(interaction.type!==3n)throw new InteractionRouteError('WrongInteractionType');const data=interaction.data as {custom_id:string},component=parseComponentId(data.custom_id);if(component===null)throw new InteractionRouteError('UnknownComponent');for(const child of Object.values(component))Object.freeze(child);Object.freeze(component);return Object.freeze({initialResponse:Object.freeze({type:6 as const}),work:Object.freeze({Component:component})});}
