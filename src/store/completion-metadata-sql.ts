/** SQL selectors mechanically copied from pinned completion_work.rs; no payload reads. */
export const COMPLETION_SOURCES=Object.freeze(["Observed","Queue","AsyncOrphan","Commentary","Goal","StartFailure","Question","Final"] as const);
export type CompletionSource=typeof COMPLETION_SOURCES[number];
export const COMPLETION_PAGE_SIZE=32;
export const MAX_COMPLETION_METADATA_BYTES=4096;
export const MAX_COMPLETION_PAYLOAD_BYTES=2*1024*1024;
export function requireCompletionSource(value:unknown):asserts value is CompletionSource{if(typeof value!=="string"||!(COMPLETION_SOURCES as readonly string[]).includes(value))throw new TypeError("Unknown completion source");}
export function completionSourceIsState(source:CompletionSource):boolean{requireCompletionSource(source);return source==="Observed"||source==="Queue"||source==="AsyncOrphan";}
const SELECT:Readonly<Record<CompletionSource,string>>=Object.freeze({
  "Observed": "SELECT 0 stamp,rowid ordinal,'' sort_id,thread_id id,\n                thread_id target,turn_id turn,0 channel,length(CAST(payload AS BLOB)) bytes\n                FROM codex_observed_completions",
  "Queue": "SELECT DISTINCT 0 stamp,0 ordinal,target_thread_id sort_id,\n                target_thread_id id,target_thread_id target,'' turn,0 channel,0 bytes\n                FROM codex_turn_queue WHERE state<>'quarantined'",
  "AsyncOrphan": "SELECT DISTINCT 0 stamp,0 ordinal,o.thread_id sort_id,\n                o.thread_id id,o.thread_id target,'' turn,0 channel,0 bytes\n                FROM cdr_async_execution_obligations o WHERE o.execution_state='unresolved'\n                AND NOT EXISTS(SELECT 1 FROM codex_turn_queue q WHERE q.job_id=o.origin_job_id)\n                AND NOT EXISTS(SELECT 1 FROM codex_turn_queue q\n                    WHERE q.target_thread_id=o.thread_id AND q.state<>'pending')",
  "Commentary": "SELECT 0 stamp,sequence ordinal,'' sort_id,\n                CAST(sequence AS TEXT) id,target_thread_id target,turn_id turn,channel_id channel,\n                length(CAST(text AS BLOB)) bytes FROM codex_commentary_outbox",
  "Goal": "SELECT 0 stamp,rowid ordinal,'' sort_id,thread id,\n                thread target,turn,channel,length(CAST(content AS BLOB)) bytes\n                FROM codex_goal_progress",
  "StartFailure": "SELECT created_at stamp,0 ordinal,job_id sort_id,job_id id,\n                target_thread_id target,'' turn,channel_id channel,\n                length(CAST(content AS BLOB)) bytes FROM codex_reserve_start_notices",
  "Question": "SELECT created_at stamp,CAST(json_extract(body,'$.index') AS INTEGER) ordinal,\n                id sort_id,id,thread_id target,turn_id turn,channel_id channel,\n                length(CAST(body AS BLOB)) bytes FROM cdr_async_questions\n                WHERE state='observed' AND runtime_id=(SELECT runtime FROM scope)\n                AND generation=(SELECT generation FROM scope)",
  "Final": "SELECT created_at stamp,0 ordinal,delivery_id sort_id,delivery_id id,\n                target_thread_id target,turn_id turn,channel_id channel,\n                length(CAST(content AS BLOB)) bytes FROM codex_delivery_outbox"
});
const HELD:Readonly<Record<CompletionSource,string>>=Object.freeze({
  "Observed": "0",
  "Queue": "0",
  "AsyncOrphan": "0",
  "StartFailure": "r.channel=h.channel AND r.domain='reserve/start-failure/v1' AND r.logical=h.id",
  "Goal": "r.channel=h.channel AND r.domain='completion/goal-progress/v1' AND\n                r.logical=length(CAST(h.target AS BLOB))||':'||h.target||';'||\n                    length(CAST(h.turn AS BLOB))||':'||h.turn||';'",
  "Commentary": "r.channel=h.channel AND r.domain='completion/commentary/v1' AND\n                instr(r.logical,length(CAST(h.target AS BLOB))||':'||h.target||';'||\n                    length(CAST(h.turn AS BLOB))||':'||h.turn||';')=1",
  "Question": "r.channel=h.channel AND (\n                (r.domain IN ('async-question-v1','async-question-body-v1') AND r.logical=h.id)\n                OR (r.domain='async-question-item-text-v1' AND EXISTS(\n                    SELECT 1 FROM cdr_async_questions q WHERE q.id=h.id AND\n                    r.logical=json_array(q.thread_id,q.turn_id,q.item_id))))",
  "Final": "r.channel=h.channel AND r.domain='completion/v1' AND r.logical=h.id"
});
export function completionHeldMatch(source:CompletionSource):string{requireCompletionSource(source);return HELD[source];}
/** Supplemental Rust main ed47c482: final-current probes scope the original channel before ranking. */
export function completionMetadataQuery(source:CompletionSource,channelScoped=false):string{
  requireCompletionSource(source);if(typeof channelScoped!=="boolean")throw new TypeError("Expected channel scope flag");const lane=completionSourceIsState(source)?"target":"channel",input=channelScoped&&source==="Final"?`${SELECT[source]} WHERE channel_id=?6`:SELECT[source];
  return `WITH scope AS (SELECT ?1 runtime,?2 generation), source_input AS (${input}),
    ranked AS (SELECT *,row_number() OVER (PARTITION BY ${lane} ORDER BY stamp,ordinal,sort_id) lane_rank FROM source_input),
    unavailable AS (SELECT
      json_extract(CASE WHEN json_valid(receipt_key) THEN receipt_key ELSE '[]' END,'$[0]') channel,
      json_extract(CASE WHEN json_valid(receipt_key) THEN receipt_key ELSE '[]' END,'$[1]') domain,
      json_extract(CASE WHEN json_valid(receipt_key) THEN receipt_key ELSE '[]' END,'$[2]') logical
      FROM codex_delivery_receipts WHERE message_id IS NULL AND (retryable=0 OR blocked_reason IS NOT NULL)),
    heads AS (SELECT * FROM ranked WHERE lane_rank=1 AND
      length(CAST(sort_id AS BLOB))+length(CAST(id AS BLOB))+length(CAST(target AS BLOB))+length(CAST(turn AS BLOB))<=${MAX_COMPLETION_METADATA_BYTES}),
    candidates AS (SELECT * FROM heads h WHERE NOT EXISTS(SELECT 1 FROM unavailable r WHERE ${HELD[source]}))`;
}
