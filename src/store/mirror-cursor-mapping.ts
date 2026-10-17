import type {DatabaseSync} from 'node:sqlite';
import {StoreIntegrityError} from './schema-assembly.ts';
import {decodeI64} from './sqlite-values.ts';
import {requireDiscordText} from '../discord/text.ts';
export class MirrorCursorMappingChangedError extends Error{
 constructor(){super('Current mirror thread/channel mapping is missing, ambiguous or changed');this.name='MirrorCursorMappingChangedError';}
}
/** Current exact thread→Discord room guard inside an existing transaction.
 * Bounded scalar rows only. No network, no transaction management, no schema
 * creation and no inference from old mapping snapshots. This is not send/skip
 * ownership and does not itself prove current project or parent-room policy. */
export function requireExactMirrorChannelIn(db:DatabaseSync,thread:string,channel:bigint):void{
 requireDiscordText(thread);
 if(thread.length>16384||Buffer.byteLength(thread)>16384)throw new RangeError('Mirror mapping thread budget exceeded');
 if(typeof channel!=='bigint'||channel<=0n||channel>=(1n<<63n))throw new RangeError('Expected mapped positive i64 channel');
 if(!db.isTransaction)throw new StoreIntegrityError('Mirror channel guard requires an active transaction');
 const q=db.prepare('SELECT discord_thread_id,CAST(codex_thread_id AS BLOB)=CAST(? AS BLOB) AS exact FROM mirror_threads WHERE codex_thread_id=? LIMIT 2');q.setReadBigInts(true);
 const rows=q.all(thread,thread);
 if(rows.length!==1||rows[0]!.exact!==1n||decodeI64(rows[0]!.discord_thread_id,'discord_thread_id')!==channel)throw new MirrorCursorMappingChangedError();
 const foreign=db.prepare('SELECT 1 FROM mirror_threads WHERE discord_thread_id=? AND CAST(codex_thread_id AS BLOB) IS NOT CAST(? AS BLOB) LIMIT 1').get(channel,thread);
 if(foreign!==undefined)throw new MirrorCursorMappingChangedError();
}
