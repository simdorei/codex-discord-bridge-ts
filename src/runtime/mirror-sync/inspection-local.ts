import {statSync} from 'node:fs';
import {CodexThreadStore} from '../../codex-state/store.ts';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import type {MirrorTarget} from '../../store/mirror-policy-read.ts';
import {requireDiscordText} from '../../discord/text.ts';
export interface MirrorInspectionLocal {
 readonly mappings:readonly {readonly row:MirrorTarget;readonly stale:boolean;readonly duplicate:boolean}[];
 readonly parents:readonly bigint[];readonly details:readonly string[];readonly projectSummary:string;
 readonly expected:number;readonly missing:number;readonly duplicates:number;readonly stale:number;readonly rollouts:readonly {readonly id:string;readonly path:string}[];readonly projectsOk:boolean;
}
const byteOrder=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const line=(s:string)=>s.replace(/[\r\n]/gu,' ');
/** Worker-only local observation. The two Codex reads intentionally retain source
 * semantics: a root appearing between reads is reported as changed, never silently
 * dropped or treated as an atomic cross-database inventory. */
export function inspectLocalBlocking(codex:string,mirror:string):MirrorInspectionLocal{
 requireDiscordText(codex);requireDiscordText(mirror);const snapshot=state.mirrorInspectionSnapshotReadonly(mirror),store=CodexThreadStore.open(codex);
 const active=new Map(store.loadRecentThreads(0n).map(t=>[t.id,t])),expected=new Set(store.loadMirrorRootThreads(0n).map(t=>t.id));
 for(const row of snapshot.mappings)if(active.has(row.codexThreadId))expected.add(row.codexThreadId);
 const ordered=[...expected].sort(byteOrder),mapped=new Set(snapshot.mappings.map(r=>r.codexThreadId)),missing=ordered.filter(id=>!mapped.has(id)),rooms=new Map<bigint,number>(),parents=new Set(snapshot.parents),stale=new Set<string>();
 for(const row of snapshot.mappings){rooms.set(row.discordThreadId,(rooms.get(row.discordThreadId)??0)+1);parents.add(row.discordChannelId);if(!active.has(row.codexThreadId))stale.add(row.codexThreadId);}
 const details=missing.map(id=>{const t=active.get(id);return t===undefined?`missing_mapping | ${id} | source changed during inventory; recheck`:`missing_mapping | ${id} | title=${line(t.title)} | cwd=${line(t.cwd)}`;});details.push(...snapshot.projectIssues);
 const rollouts=ordered.flatMap(id=>{const t=active.get(id);return t===undefined?[]:[{id:t.id,path:t.rolloutPath}];});
 return {mappings:snapshot.mappings.map(row=>({row,stale:stale.has(row.codexThreadId),duplicate:rooms.get(row.discordThreadId)!>1})),parents:[...parents].sort((a,b)=>a<b?-1:a>b?1:0),details,projectSummary:snapshot.projectSummary,expected:expected.size,missing:missing.length,duplicates:[...rooms.values()].filter(n=>n>1).length,stale:stale.size,rollouts,projectsOk:snapshot.projectIssues.length===0};
}

/** Second owned observation, after guild discovery, matching source ordering. */
export function inspectRolloutsBlocking(rollouts:MirrorInspectionLocal['rollouts']):readonly string[]{
 const missing:string[]=[];
 for(const item of rollouts){requireDiscordText(item.id);requireDiscordText(item.path);let exists=false;try{exists=statSync(item.path).isFile();}catch{}if(!exists)missing.push(item.id);}
 return missing;
}
