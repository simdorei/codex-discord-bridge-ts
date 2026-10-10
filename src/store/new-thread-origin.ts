import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {mirroredThreadIdIn} from "./busy-choice.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
export interface NewThreadOrigin {version:bigint;channel:bigint;target:string|null;mapped_project:string|null;parent_channel:bigint|null;project:string|null;parent_project:string|null;chat_targets:string[]}
function requireChannel(channel:bigint):void{
  if(typeof channel!=="bigint"||channel<-(1n<<63n)||channel>=(1n<<63n))throw new TypeError("Expected i64 channel");
}
function projectKey(db:DatabaseSync,channel:bigint):string|null{
  const values:string[]=[];for(const row of db.prepare(`SELECT project_key,CAST(project_key AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding
    FROM mirror_projects WHERE discord_channel_id=? ORDER BY project_key LIMIT 2`).iterate(channel))values.push(decodeTextField(row.project_key,row.raw,"project_key",false,textDecoderFor(row.encoding))!);
  if(values.length>1)throw new StoreIntegrityError("new origin has multiple project mappings");return values[0]??null;
}
/** Semantic route snapshot only; titles and timestamps are not creation authority. */
export function newThreadOriginIn(db:DatabaseSync,channel:bigint):NewThreadOrigin{
  requireChannel(channel);
  const target=mirroredThreadIdIn(db,channel);let mappedProject:string|null=null,parent:bigint|null=null;
  if(target!==null){const query=db.prepare(`SELECT project_key,discord_channel_id,CAST(project_key AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM mirror_threads WHERE codex_thread_id=?`);query.setReadBigInts(true);
    const row=query.get(target);if(row!==undefined){mappedProject=decodeTextField(row.project_key,row.raw,"project_key",false,textDecoderFor(row.encoding))!;parent=decodeI64(row.discord_channel_id,"discord_channel_id");}}
  const project=projectKey(db,channel),parentProject=parent===null?null:projectKey(db,parent),chatTargets:string[]=[];
  if(target===null&&project!==null&&(project==="codex:chats"||project.startsWith("projectless:"))){
    for(const row of db.prepare(`SELECT codex_thread_id,CAST(codex_thread_id AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding
      FROM mirror_threads WHERE discord_channel_id=? ORDER BY codex_thread_id`).iterate(channel))chatTargets.push(decodeTextField(row.codex_thread_id,row.raw,"codex_thread_id",false,textDecoderFor(row.encoding))!);
  }
  return {version:1n,channel,target,mapped_project:mappedProject,parent_channel:parent,project,parent_project:parentProject,chat_targets:chatTargets};
}
export async function newThreadOrigin(path:string,channel:bigint):Promise<NewThreadOrigin>{
  requireChannel(channel);const db=await openInitialized(path);try{db.exec("BEGIN");const origin=newThreadOriginIn(db,channel);db.exec("COMMIT");return origin;}
  finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}
