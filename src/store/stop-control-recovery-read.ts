import {usingExistingStore} from './owned-scope.ts';
import {decodeI64,decodeTextField,textDecoderFor} from './sqlite-values.ts';
import {parseStopControlJson,type StopControl} from './stop-control-dispatch.ts';
/** PR5 bounded recovery inventory only. Does not authorize settlement or replay. */
export function recoveryStopControlsAfter(path:string,after:bigint):readonly (readonly [bigint,StopControl])[]{
 if(typeof path!=='string'||/[\uD800-\uDFFF]/u.test(path))throw new TypeError('Expected well-formed stop path');
 if(typeof after!=='bigint'||after<-(1n<<63n)||after>=(1n<<63n))throw new RangeError('Expected i64 stop cursor');
 return usingExistingStore(path,db=>{db.exec('PRAGMA busy_timeout=500');
 const q=db.prepare("SELECT sequence,record_json,CAST(record_json AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM cdr_stop_controls c WHERE sequence>? AND json_extract(record_json,'$.can_settle')=1 AND (phase<>'settled' OR EXISTS(SELECT 1 FROM json_each(record_json,'$.jobs') j JOIN codex_turn_queue q ON q.job_id=json_extract(j.value,'$.job_id'))) ORDER BY sequence LIMIT 16");q.setReadBigInts(true);
 const rows=q.all(after).map(row=>[decodeI64(row.sequence,'sequence'),decodeTextField(row.record_json,row.raw,'record_json',false,textDecoderFor(row.encoding))!] as const);
 return Object.freeze(rows.map(([seq,raw])=>Object.freeze([seq,parseStopControlJson(raw)] as const)));
 });
}
