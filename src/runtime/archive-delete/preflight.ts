import type {DatabaseSync} from 'node:sqlite';
import {realpathSync} from 'node:fs';
import {dirname,basename,join,relative,isAbsolute} from 'node:path';
import {requireDiscordText} from '../../discord/text.ts';
export class ArchivePreflightError extends Error{constructor(readonly kind:'MissingThread'|'ActiveThread'|'OutsideArchive'|'InvalidRollout'){super('Archive preflight: '+kind);this.name='ArchivePreflightError';}}
/** Borrowed native-worker read. SQL byte cap and raw UTF8 decoding prevent large
 * values or replacement-character path changes from becoming file authority. */
export function loadArchivedRolloutIn(db:DatabaseSync,id:string):string{
 requireDiscordText(id);
 const query=db.prepare("SELECT typeof(rollout_path) AS type,CASE WHEN typeof(rollout_path)='text' AND length(CAST(rollout_path AS BLOB))<=32768 THEN CAST(rollout_path AS BLOB) END AS path,CASE WHEN typeof(archived)='integer' THEN archived END AS archived FROM threads WHERE id=?1");query.setReadBigInts(true);
 const row=query.get(id);if(row===undefined)throw new ArchivePreflightError('MissingThread');
 if(row.type!=='text'||!(row.path instanceof Uint8Array)||typeof row.archived!=='bigint')throw new ArchivePreflightError('InvalidRollout');
 let path:string;try{path=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(row.path);}catch{throw new ArchivePreflightError('InvalidRollout');}
 if(path===''||path.includes('\0'))throw new ArchivePreflightError('InvalidRollout');
 if(row.archived!==1n)throw new ArchivePreflightError('ActiveThread');return path;
}
/** Native-worker containment snapshot, not a durable file lock. Must recheck
 * immediately before transcript deletion while holding platform ownership.
 * A missing leaf is resolved against its existing canonical parent, matching
 * Rust preflight; later opening the mandatory transcript must still succeed. */
export function assertArchivedRolloutContained(rollout:string,root:string):void{
 requireDiscordText(rollout);requireDiscordText(root);if(rollout===''||root===''||rollout.includes('\0')||root.includes('\0'))throw new ArchivePreflightError('OutsideArchive');
 const canonicalRoot=realpathSync(root);let candidate:string;
 try{candidate=realpathSync(rollout);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const name=basename(rollout);if(name===''||name==='.'||name==='..')throw new ArchivePreflightError('OutsideArchive');candidate=join(realpathSync(dirname(rollout)),name);}
 const child=relative(canonicalRoot,candidate);
 if(child===''||child==='..'||child.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(child))throw new ArchivePreflightError('OutsideArchive');
}
