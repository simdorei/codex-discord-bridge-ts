import {usingInitializedStore} from "./owned-scope.ts";
import {decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {I64_MIN,I64_MAX} from "../protocol/ids.ts";
function identity(thread:string,turn:string,generation:bigint):void{for(const text of [thread,turn])if(typeof text!=="string"||/[\uD800-\uDFFF]/u.test(text))throw new TypeError("Expected well-formed final identity");if(typeof generation!=="bigint"||generation<I64_MIN||generation>I64_MAX)throw new RangeError("Expected i64 final generation");}
/** Live exact final producer. First owned value survives duplicate/conflicting events. */
export function recordObservedFinalAnswer(path:string,thread:string,turn:string,generation:bigint,content:string):Promise<boolean>{
  identity(thread,turn,generation);if(typeof content!=="string"||/[\uD800-\uDFFF]/u.test(content))throw new TypeError("Expected well-formed final content");
  return usingInitializedStore(path,db=>BigInt(db.prepare(`INSERT OR IGNORE INTO codex_observed_final_answers (thread_id,turn_id,generation,content)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM codex_turn_queue WHERE target_thread_id=? AND turn_id=?
      AND COALESCE(turn_observation_generation,app_server_generation)=? AND state='running')`).run(thread,turn,generation,content,thread,turn,generation).changes)===1n);
}
export function getObservedFinalAnswer(path:string,thread:string,turn:string,generation:bigint):Promise<string|null>{
  identity(thread,turn,generation);return usingInitializedStore(path,db=>{
    const row=db.prepare(`SELECT content,CAST(content AS BLOB) AS content_raw,(SELECT encoding FROM pragma_encoding) AS encoding
      FROM codex_observed_final_answers WHERE thread_id=? AND turn_id=? AND generation=?`).get(thread,turn,generation);
    return row===undefined?null:decodeTextField(row.content,row.content_raw,"content",false,textDecoderFor(row.encoding))!;
  });
}
