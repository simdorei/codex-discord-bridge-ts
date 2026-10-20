import {DatabaseSync} from 'node:sqlite';
import {LATEST_STORE_SCHEMA_VERSION} from './schema-assembly.ts';
import {decodeI64,decodeTextField,textDecoderFor} from './sqlite-values.ts';
function text(value:unknown):asserts value is string{if(typeof value!=='string'||/[\uD800-\uDFFF]/u.test(value))throw new TypeError('Expected diagnostic path');}
/** Read-only existing files only. No initialize, migration, writer transaction or
 * caller-controlled SQL identifier. Counts do not certify whole DB integrity. */
export function diagnosticDatabaseCounts(path:string,kind:'State'|'Mirror'|'Queue'):string {
 text(path);if(!['State','Mirror','Queue'].includes(kind))throw new TypeError('Unknown diagnostic database kind');
 const db=new DatabaseSync(path,{readOnly:true});try{
  db.exec('PRAGMA busy_timeout=250');const versionQuery=db.prepare('PRAGMA user_version');versionQuery.setReadBigInts(true);const version=decodeI64(versionQuery.get()?.user_version,'user_version');
  if(kind!=='State'&&version!==LATEST_STORE_SCHEMA_VERSION)throw new Error(`schema version ${version}; supported ${LATEST_STORE_SCHEMA_VERSION} (migration not attempted)`);
  const tables=kind==='State'?['threads']:kind==='Mirror'?['mirror_threads','codex_turn_queue']:['codex_turn_queue'],counts:string[]=[];
  for(const table of tables){const q=db.prepare(`SELECT COUNT(*) AS n FROM ${table}`);q.setReadBigInts(true);counts.push(`${table}=${decodeI64(q.get()?.n,'count')}`);}
  return `read OK · schema=${version} · ${counts.join(', ')}`;
 }finally{db.close();}
}
export function diagnosticIdleRelease(path:string):string {
 text(path);const db=new DatabaseSync(path,{readOnly:true});try{
  db.exec('PRAGMA busy_timeout=250');const exists=db.prepare("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='cdr_idle_release') AS present");exists.setReadBigInts(true);
  if(decodeI64(exists.get()?.present,'present')===0n)return '봇 연결 해제 상태: 이전 저장 형식 (변경하지 않음)';
  const encoding=db.prepare('PRAGMA encoding').get()?.encoding,decoder=textDecoderFor(encoding),counts=db.prepare("SELECT state,CAST(state AS BLOB) AS raw,COUNT(*) AS n FROM cdr_idle_release WHERE state!='Settled' GROUP BY state ORDER BY state");counts.setReadBigInts(true);
  const rows=counts.all().map(row=>`${decodeTextField(row.state,row.raw,'state',false,decoder)}=${decodeI64(row.n,'count')}`),lines=[`봇 연결 해제 상태: ${rows.length===0?'보류 없음':rows.join(', ')}`];
  const query=db.prepare("SELECT thread_id,state,detail,CAST(thread_id AS BLOB) AS t,CAST(state AS BLOB) AS s,CAST(detail AS BLOB) AS d FROM cdr_idle_release WHERE state IN ('Dispatching','Resubscribing','Unknown') ORDER BY thread_id LIMIT 3");
  for(const row of query.all()){const thread=decodeTextField(row.thread_id,row.t,'thread_id',false,decoder)!,state=decodeTextField(row.state,row.s,'state',false,decoder)!,detail=[...decodeTextField(row.detail,row.d,'detail',false,decoder)!].slice(0,160).join('');lines.push(`${thread} · ${state}: ${detail} · 자동 재실행 보류`);}
  return lines.join('\n');
 }finally{db.close();}
}
