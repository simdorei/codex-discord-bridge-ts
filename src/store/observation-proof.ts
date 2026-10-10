import type {DatabaseSync} from "node:sqlite";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {commitStore,rollbackStore,withStoreTransaction,usingInitializedStore} from "./owned-scope.ts";
import {type ObservationScope,type ObservationGap,scope,integer,text,active,scalar,GAP_COLUMNS,readGapRow,readGap,saveGap,gapEqual,gapComplete,gapContains,addVerifiedSequence,cloneObservationGap} from "./observation-gap-model.ts";
export type ObservationEffect={readonly kind:"NoRequiredStore"|"Unconfirmed"}|{readonly kind:"Started";readonly thread:string;readonly turn:string}|{readonly kind:"Terminal";readonly thread:string;readonly turn:string;readonly payload:string}|{readonly kind:"Final";readonly thread:string;readonly turn:string;readonly content:string}|{readonly kind:"Question";readonly id:string;readonly thread:string;readonly turn:string;readonly item:string;readonly body:string};
function effectsSnapshot(input:readonly ObservationEffect[]):readonly ObservationEffect[]{
  const owned=cloneOwnedSerdeValue(input);if(!Array.isArray(owned))throw new TypeError("Expected observation effects");
  for(const v of owned){if(v===null||typeof v!=="object"||Array.isArray(v)||!Object.hasOwn(v,"kind"))throw new TypeError("Expected observation effect");let fields:string[];
    switch(v.kind){case "NoRequiredStore":case "Unconfirmed":fields=[];break;case "Started":fields=["thread","turn"];break;case "Terminal":fields=["thread","turn","payload"];break;case "Final":fields=["thread","turn","content"];break;case "Question":fields=["id","thread","turn","item","body"];break;default:throw new TypeError("Unknown observation effect");}
    if(Object.keys(v).length!==fields.length+1||fields.some(k=>!Object.hasOwn(v,k)))throw new TypeError("Unexpected observation effect fields");for(const key of fields)text(v[key]);
  }return owned as ObservationEffect[];
}
function completed(db:DatabaseSync,s:ObservationScope,thread:string,turn:string):boolean{
  return scalar(db,`SELECT EXISTS(SELECT 1 FROM cdr_idle_release i
    JOIN codex_session_mirror_events e ON e.event_digest=?5 AND e.codex_thread_id=i.thread_id
    WHERE i.owner_id=?1 AND i.generation=?2 AND i.thread_id=?3 AND i.turn_id=?4 AND i.job_id!='') AS n`,s.ownerId,s.generation,thread,turn,`discord-origin:v1:${thread}:${turn}`)!==0n;
}
function matchesEffect(db:DatabaseSync,s:ObservationScope,e:ObservationEffect):boolean{
  switch(e.kind){
    case "NoRequiredStore":return true;
    case "Unconfirmed":return false;
    case "Started":return completed(db,s,e.thread,e.turn)||scalar(db,`SELECT (SELECT COUNT(*) FROM codex_turn_queue WHERE target_thread_id=?1 AND state='running')=1
      AND EXISTS(SELECT 1 FROM codex_turn_queue WHERE target_thread_id=?1 AND turn_id=?2 AND state='running' AND COALESCE(turn_observation_generation,app_server_generation)=?3)
      AND NOT EXISTS(SELECT 1 FROM cdr_async_questions WHERE runtime_id=?4 AND generation=?3 AND thread_id=?1 AND turn_id!=?2 AND state NOT IN ('expired','submitted','rejected','closed_unknown')) AS n`,e.thread,e.turn,s.generation,s.ownerId)!==0n;
    case "Terminal":return scalar(db,"SELECT EXISTS(SELECT 1 FROM codex_observed_completions WHERE thread_id=?1 AND turn_id=?2 AND generation=?3 AND resident_owner=?4 AND payload=?5) AS n",e.thread,e.turn,s.generation,s.ownerId,e.payload)!==0n;
    case "Final":return scalar(db,"SELECT EXISTS(SELECT 1 FROM codex_observed_final_answers WHERE thread_id=?1 AND turn_id=?2 AND generation=?3 AND content=?4) AS n",e.thread,e.turn,s.generation,e.content)!==0n;
    case "Question":return scalar(db,`SELECT EXISTS(SELECT 1 FROM cdr_async_questions WHERE id=?1 AND runtime_id=?2 AND generation=?3 AND thread_id=?4 AND turn_id=?5 AND item_id=?6 AND body=?7 AND owner_confirmed=1)
      OR EXISTS(SELECT 1 FROM cdr_async_question_inbox i JOIN codex_turn_queue q ON q.job_id=i.candidate_job_id
        WHERE i.id=?1 AND i.runtime_id=?2 AND i.generation=?3 AND i.thread_id=?4 AND i.turn_id=?5 AND i.item_id=?6 AND i.body=?7 AND i.state='waiting' AND q.target_thread_id=i.thread_id
        AND q.channel_id=i.candidate_channel_id AND q.owner_user_id=i.candidate_owner_id AND q.app_server_generation=i.candidate_generation
        AND q.execution_generation IS i.candidate_execution_generation AND q.attempt_count=i.candidate_attempt_count AND q.state='running') AS n`,e.id,s.ownerId,s.generation,e.thread,e.turn,e.item,e.body)!==0n;
  }
}
/** Effects must come from the exact owned event producer; this is not an API for users
 * to self-assert NoRequiredStore. Required effects and positive proof share one transaction. */
export function certifyObservationOn(db:DatabaseSync,input:ObservationScope,sequence:bigint,effects:readonly ObservationEffect[]):boolean{
  const s=scope(input),owned=effectsSnapshot(effects);integer(sequence);return withStoreTransaction(db,"IMMEDIATE",()=>{
    if(!active(db,s)||owned.length===0)return rollbackStore(false);
    const q=db.prepare(`SELECT ${GAP_COLUMNS} FROM cdr_observation_gaps WHERE owner_id=?1 AND generation=?2 AND first_seq>0 AND first_seq<=?3 AND last_seq>=?3`);q.setReadBigInts(true);const row=q.get(s.ownerId,s.generation,sequence);if(row===undefined)return rollbackStore(false);const current=readGapRow(row);
    for(const effect of owned)if(!matchesEffect(db,s,effect))return rollbackStore(false);
    if(!gapContains(current,sequence)&&!saveGap(db,current,addVerifiedSequence(current,sequence)))throw new StoreIntegrityError("observation proof CAS lost");return commitStore(true);
  });
}
/** Advancing the scan cursor does not certify missing effects or erase existing spans. */
export function finishObservationPageOn(db:DatabaseSync,input:ObservationGap,through:bigint):boolean{
  const expected=cloneObservationGap(input);integer(through);if(through<=expected.cursor||through>expected.last)throw new StoreIntegrityError("invalid observation scan progress");
  return withStoreTransaction(db,"IMMEDIATE",()=>{
    if(!active(db,expected.scope))return rollbackStore(false);const current=readGap(db,expected.id);if(current===null||!gapEqual(current,expected))return rollbackStore(false);
    const updated=Object.freeze({...current,cursor:through});if(!saveGap(db,current,updated))return rollbackStore(false);
    if(through===current.last||gapComplete(updated))db.prepare("UPDATE cdr_observation_streams SET scan_after=?3 WHERE owner_id=?1 AND generation=?2").run(current.scope.ownerId,current.scope.generation,current.id);
    return commitStore(true);
  });
}
export function certifyObservation(path:string,input:ObservationScope,sequence:bigint,effects:readonly ObservationEffect[]):Promise<boolean>{const s=scope(input),owned=effectsSnapshot(effects);integer(sequence);return usingInitializedStore(path,db=>certifyObservationOn(db,s,sequence,owned));}
export function finishObservationPage(path:string,input:ObservationGap,through:bigint):Promise<boolean>{const expected=cloneObservationGap(input);integer(through);return usingInitializedStore(path,db=>finishObservationPageOn(db,expected,through));}
