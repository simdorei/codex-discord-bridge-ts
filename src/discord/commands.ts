export interface DiscordSlashOption{readonly autocomplete?:true;readonly description:'…';readonly type:3|4|5;readonly name:string;readonly required?:true}
export interface DiscordSlashCommand{readonly default_member_permissions:null;readonly description:string;readonly type:1;readonly name:string;readonly options:readonly DiscordSlashOption[];readonly version:'1'}
type OptionSpec=readonly[name:string,kind:3|4|5,required?:boolean,autocomplete?:boolean];
type CommandSpec=readonly[name:string,description:string,options:readonly OptionSpec[],conditional?:boolean];
const LIMIT:readonly OptionSpec[]=[['limit',4]],REF_REQUIRED:readonly OptionSpec[]=[['ref',3,true]],REF_OPTIONAL:readonly OptionSpec[]=[['ref',3]],PROMPT:readonly OptionSpec[]=[['prompt',3,true]];
const SETTINGS:readonly OptionSpec[]=[['ref',3],['model',3,false,true],['effort',3,false,true],['speed',3]];
const CONTEXT:readonly OptionSpec[]=[['all_threads',5],['refresh',5],['limit',4]],DAYS:readonly OptionSpec[]=[['days',4]];
const specs:readonly CommandSpec[]=[
 ['help','Show Discord Codex commands.',[]],['list','Show recent Codex threads.',LIMIT],['archived_list','Show archived Codex threads.',LIMIT],
 ['use','Select the active Codex thread.',REF_REQUIRED],['status','Show selected Codex thread status.',REF_OPTIONAL],['settings','Update Codex thread model, effort, or speed.',SETTINGS],
 ['where','Show the Codex thread mapped to this Discord channel.',[]],['context','Show context usage for this Codex thread.',CONTEXT],['usage','Show live Codex usage and rate limits.',DAYS],
 ['new','Create a new Codex thread with the first prompt.',PROMPT],['ask','Send a prompt to the mapped or selected Codex thread.',PROMPT],['interview','Clarify a request before implementation.',PROMPT],
 ['doctor','Run Codex bridge diagnostics.',[]],['approval','Show existing Codex approval and input requests.',[]],['runners','Show Discord runner queues.',[]],
 ['retract','Remove your latest queued ask for this Codex thread.',REF_OPTIONAL],['mirror_check','Check Discord mirror mappings.',[]],['bridge_sync','Refresh Codex bridge state and Discord mirror.',LIMIT],['qa_buttons','Run Discord button QA smoke.',[],true],
];
function selected(qa:boolean):readonly CommandSpec[]{if(typeof qa!=='boolean')throw new TypeError('Expected QA command flag');return specs.filter(spec=>qa||!spec[3]);}
export function slashCommandNames(qa:boolean):readonly string[]{return Object.freeze(selected(qa).map(spec=>spec[0]));}
/** Exact pinned Command/CommandOption serialization profile. None permissions is
 * JSON null, other absent optionals are omitted, options includes empty arrays,
 * version Id(1) serializes as string. No arbitrary caller command data accepted. */
export function slashCommands(qa:boolean):readonly DiscordSlashCommand[]{return Object.freeze(selected(qa).map(([name,description,options])=>Object.freeze({default_member_permissions:null,description,type:1 as const,name,options:Object.freeze(options.map(([name,type,required,autocomplete])=>Object.freeze({...(!autocomplete?{}:{autocomplete:true as const}),description:'…' as const,type,name,...(!required?{}:{required:true as const})}))),version:'1' as const})));}
export function slashCommandRegistrationRequest(applicationId:bigint,guildId:bigint|null,qa:boolean):{readonly method:'PUT';readonly path:string;readonly body:string}{
 const valid=(v:bigint)=>{if(typeof v!=='bigint'||v<=0n||v>(1n<<64n)-1n)throw new TypeError('Expected nonzero u64 Discord ID');};valid(applicationId);if(guildId!==null)valid(guildId);return Object.freeze({method:'PUT',path:`applications/${applicationId}/${guildId===null?'':`guilds/${guildId}/`}commands`,body:JSON.stringify(slashCommands(qa))});
}
