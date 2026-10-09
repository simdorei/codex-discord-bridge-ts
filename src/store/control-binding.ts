import {usingInitializedStore, withStoreTransaction, commitStore} from './owned-scope.ts';
import {decodeTextField, textDecoderFor} from './sqlite-values.ts';
import {requireDiscordText} from '../discord/text.ts';
export function bindBusyControl(path: string, choice: string, thread: string, turn: string | null, job: string | null): Promise<void> {
  for (const value of [path, choice, thread, ...(turn === null ? [] : [turn]), ...(job === null ? [] : [job])]) requireDiscordText(value);
  return usingInitializedStore(path, db => withStoreTransaction(db, 'IMMEDIATE', () => {
    db.exec('DELETE FROM codex_busy_control_bindings WHERE choice_id NOT IN (SELECT choice_id FROM busy_choices)');
    db.prepare('INSERT OR IGNORE INTO codex_busy_control_bindings (choice_id,thread_id,turn_id,job_id) VALUES (?,?,?,?)').run(choice, thread, turn, job);
    return commitStore(undefined);
  }));
}
/** Resolve only the original explicit turn or exact preceding running job. The
 * existing migration trigger pins the first observed turn before goal advances. */
export function resolveBusyControl(path: string, choice: string, thread: string): Promise<string | null> {
  for (const value of [path, choice, thread]) requireDiscordText(value);
  return usingInitializedStore(path, db => withStoreTransaction(db, 'IMMEDIATE', () => {
    const query = db.prepare('SELECT turn_id,job_id,CAST(turn_id AS BLOB) AS raw_turn,CAST(job_id AS BLOB) AS raw_job,(SELECT encoding FROM pragma_encoding) AS encoding FROM codex_busy_control_bindings WHERE choice_id=? AND thread_id=?');
    query.setReadBigInts(true); const row = query.get(choice, thread); if (row === undefined) return commitStore(null);
    const decoder = textDecoderFor(row.encoding), turn = decodeTextField(row.turn_id, row.raw_turn, 'turn_id', true, decoder), job = decodeTextField(row.job_id, row.raw_job, 'job_id', true, decoder);
    if (turn !== null || job === null) return commitStore(turn);
    const jobs = db.prepare("SELECT turn_id,CAST(turn_id AS BLOB) AS raw_turn,(SELECT encoding FROM pragma_encoding) AS encoding FROM codex_turn_queue WHERE job_id=? AND target_thread_id=? AND state='running' AND goal_waiting=0");
    jobs.setReadBigInts(true); const running = jobs.get(job, thread);
    const resolved = running === undefined ? null : decodeTextField(running.turn_id, running.raw_turn, 'turn_id', true, textDecoderFor(running.encoding));
    if (resolved !== null) db.prepare('UPDATE codex_busy_control_bindings SET turn_id=? WHERE choice_id=? AND turn_id IS NULL').run(resolved, choice);
    return commitStore(resolved);
  }));
}
