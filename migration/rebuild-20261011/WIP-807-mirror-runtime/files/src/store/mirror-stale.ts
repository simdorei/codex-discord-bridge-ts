import {usingInitializedStore} from './owned-scope.ts';
import {receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeI64} from './sqlite-values.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {requireDiscordText} from '../discord/text.ts';
export interface StaleMirrorThread {readonly threadId:string;readonly discordThreadId:bigint;readonly title:string}
export interface StaleMirrorProject {readonly projectKey:string;readonly projectName:string;readonly discordChannelId:bigint}
function validSet(input:readonly string[]):Set<string>{const a=cloneOwnedSerdeValue(input);if(!Array.isArray(a))throw new TypeError('Expected valid identity array');for(const x of a)requireDiscordText(x);return new Set(a);}
function f64(value:unknown):number {if(typeof value==='bigint')return Number(value);if(typeof value==='number')return value;throw new StoreIntegrityError('Expected REAL or INTEGER mapping timestamp');}
export async function staleMirrorThreads(path:string,valid:readonly string[],before:number):Promise<readonly StaleMirrorThread[]> {
 requireDiscordText(path);const ids=validSet(valid);if(typeof before!=='number')throw new TypeError('Expected f64 cutoff');return usingInitializedStore(path,db=>{
  const q=db.prepare(`SELECT codex_thread_id,discord_thread_id,thread_title,updated_at,${receiptTextColumns('codex_thread_id','thread_title')} FROM mirror_threads`);q.setReadBigInts(true);
  const rows=q.all().map(r=>({value:Object.freeze({threadId:receiptText(r,'codex_thread_id')!,discordThreadId:decodeI64(r.discord_thread_id,'discord_thread_id'),title:receiptText(r,'thread_title')!}),updated:f64(r.updated_at)}));return Object.freeze(rows.filter(r=>!ids.has(r.value.threadId)&&r.updated<before).map(r=>r.value));
 });
}
export async function staleMirrorProjects(path:string,valid:readonly string[],before:number):Promise<readonly StaleMirrorProject[]> {
 requireDiscordText(path);const keys=validSet(valid);if(typeof before!=='number')throw new TypeError('Expected f64 cutoff');return usingInitializedStore(path,db=>{
  const q=db.prepare(`SELECT project_key,project_name,discord_channel_id,updated_at,${receiptTextColumns('project_key','project_name')} FROM mirror_projects`);q.setReadBigInts(true);
  const rows=q.all().map(r=>({value:Object.freeze({projectKey:receiptText(r,'project_key')!,projectName:receiptText(r,'project_name')!,discordChannelId:decodeI64(r.discord_channel_id,'discord_channel_id')}),updated:f64(r.updated_at)}));return Object.freeze(rows.filter(r=>!keys.has(r.value.projectKey)&&r.updated<before).map(r=>r.value));
 });
}
