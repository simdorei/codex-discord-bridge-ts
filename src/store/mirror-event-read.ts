import {usingInitializedStore} from "./owned-scope.ts";
import {decodeI64} from "./sqlite-values.ts";
function text(v:unknown):asserts v is string{if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed mirror identity");}
export function turnOriginMarker(thread:string,turn:string):string{text(thread);text(turn);return `discord-origin:v1:${thread}:${turn}`;}
/** Presence of the exact bot completion marker; not current execution authority. */
export async function hasMirrorEvent(path:string,digest:string,thread:string):Promise<boolean>{
 text(digest);text(thread);return usingInitializedStore(path,db=>{const q=db.prepare("SELECT 1 AS present FROM codex_session_mirror_events WHERE event_digest = ? AND codex_thread_id = ?");q.setReadBigInts(true);const row=q.get(digest,thread);if(row===undefined)return false;decodeI64(row.present,"mirror event presence");return true;});
}
