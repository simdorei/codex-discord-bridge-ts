import {usingExistingStore} from "./owned-scope.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {parseStopControlJson,type StopControl} from "./stop-control-dispatch.ts";
function text(v:unknown):void{if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed stop identity");}
/** Bounded existing-only keyset metadata. All SQLite row decoding precedes typed
 * JSON decoding, matching source collect-then-map order. No claim or retry grant. */
export function pendingStopControlsAfter(path:string,after:bigint):readonly (readonly [bigint,StopControl])[]{
  text(path);if(typeof after!=="bigint"||after<-(1n<<63n)||after>=(1n<<63n))throw new RangeError("Expected i64 stop cursor");
  return usingExistingStore(path,db=>{db.exec("PRAGMA busy_timeout=500");const q=db.prepare("SELECT sequence,record_json,CAST(record_json AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM cdr_stop_controls WHERE phase='accepted' AND sequence>? ORDER BY sequence LIMIT 16");q.setReadBigInts(true);
    const rows=q.all(after).map(r=>[decodeI64(r.sequence,"sequence"),decodeTextField(r.record_json,r.raw,"record_json",false,textDecoderFor(r.encoding))!] as const);
    return Object.freeze(rows.map(([seq,raw])=>Object.freeze([seq,parseStopControlJson(raw)] as const)));
  });
}
export function stopControlPhase(path:string,operation:string):string|null{
  text(path);text(operation);return usingExistingStore(path,db=>{db.exec("PRAGMA busy_timeout=500");const r=db.prepare("SELECT phase,CAST(phase AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM cdr_stop_controls WHERE operation_id=?").get(operation);return r===undefined?null:decodeTextField(r.phase,r.raw,"phase",false,textDecoderFor(r.encoding));});
}
