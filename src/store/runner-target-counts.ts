import {openInitialized} from './owned-driver.ts';
import {decodeI64} from './sqlite-values.ts';
const SQL=`SELECT
 (SELECT COUNT(*) FROM codex_turn_queue WHERE target_thread_id=?1 AND state='pending') AS queued,
 (SELECT COUNT(*) FROM codex_turn_queue WHERE target_thread_id=?1 AND state='starting') AS starting,
 (SELECT COUNT(*) FROM codex_turn_queue WHERE target_thread_id=?1 AND state='running'
  AND NOT COALESCE(instr(turn_id,'cdr-quarantined:')=1 AND instr(last_error,'[cdr-rust:app-server-fork-quarantine:v1] ')=1,0)) AS running,
 (SELECT COUNT(*) FROM codex_prompt_intakes WHERE target_thread_id=?1) AS intake,
 (SELECT COUNT(*) FROM discord_ingress_journal WHERE target_thread_id=?1 AND state='held') AS held,
 (SELECT COUNT(*) FROM discord_ingress_journal WHERE target_thread_id=?1 AND state IN ('staged','acknowledged','executing') AND owner_id IS NULL) AS unowned,
 (SELECT COUNT(*) FROM codex_turn_queue WHERE target_thread_id=?1 AND (state='quarantined' OR
  (state='running' AND instr(turn_id,'cdr-quarantined:')=1 AND instr(last_error,'[cdr-rust:app-server-fork-quarantine:v1] ')=1))) AS quarantined`;
/** One native SELECT snapshot of the source's stored counters. Does not decode
 * payloads, infer resident ownership or cancel/release any request. */
export async function runnerTargetCounts(path:string,target:string):Promise<readonly bigint[]> {
 for(const value of [path,target])if(typeof value!=='string'||/[\uD800-\uDFFF]/u.test(value))throw new TypeError('Expected well-formed runner scope');
 const db=await openInitialized(path);try{const q=db.prepare(SQL);q.setReadBigInts(true);const row=q.get(target);return Object.freeze(['queued','starting','running','intake','held','unowned','quarantined'].map(k=>decodeI64(row?.[k],k)));}finally{db.close();}
}
