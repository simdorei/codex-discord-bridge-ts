import {openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {StateAccessFacade as state} from '../store/state-access-facade.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serdeObject} from '../app-server/value.ts';
export interface DiagnosticPaths {readonly state:string;readonly mirror:string;readonly bridge:string}
const errorText=(error:unknown)=>error instanceof Error?error.message:'diagnostic read failed';
function database(label:string,path:string,kind:'State'|'Mirror'|'Queue'):string{try{return `${label}: ${state.diagnosticDatabaseCounts(path,kind)} · ${path}`;}catch(error){return `${label}: 조회 실패 · ${errorText(error)} · ${path}`;}}
function readable(label:string,path:string):string {
 let fd:number|undefined;try{fd=openSync(path,'r');const stat=fstatSync(fd,{bigint:true});if(!stat.isFile())throw new Error('not a regular file');if(stat.size>0n&&readSync(fd,Buffer.alloc(1),0,1,null)!==1)throw new Error('unexpected end of file');return `${label}: readable · ${stat.size} bytes (content not inspected)`;}catch(error){return `${label}: 조회 실패 · ${errorText(error)}`;}finally{if(fd!==undefined)closeSync(fd);}
}
function jsonFile(label:string,path:string):string {
 let fd:number|undefined;
 try{
  fd=openSync(path,'r');if(!fstatSync(fd).isFile())throw new Error('not a regular file');const limit=1048577,buffer=Buffer.alloc(limit);let used=0;
  while(used<limit){const n=readSync(fd,buffer,used,limit-used,null);if(n===0)break;used+=n;}
  if(used>1048576)throw new Error('JSON exceeds diagnostic 1MiB read budget');let value:unknown;
  try{value=parseSerdeValue(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer.subarray(0,used)));}catch{throw new Error('invalid JSON (content withheld; parser coordinates unavailable)');}
  if(!serdeObject(value))throw new Error('JSON root is not an object');return `${label}: readable JSON object (values withheld)`;
 }catch(error){return `${label}: 조회 실패 · ${errorText(error)}`;}finally{if(fd!==undefined)closeSync(fd);}
}
export function diagnosticQueueBlocking(path:string):string{return database('runner_queue',path,'Queue');}
/** Runs only in the dedicated owned worker. Package version is the current TS
 * migration package, not a claim to execute the Rust bridge or Codex UI. */
export function diagnosticReportBlocking(paths:DiagnosticPaths):string {
 const arch=process.arch==='x64'?'x86_64':process.arch==='arm64'?'aarch64':process.arch;
 const lines=[`TypeScript diagnostic · ${process.platform} ${arch} · version 0.0.0`,database('state_db',paths.state,'State'),database('mirror_db',paths.mirror,'Mirror'),jsonFile('bridge_state',paths.bridge)];
 try{lines.push(state.diagnosticIdleRelease(paths.mirror));}catch(error){lines.push(`봇 연결 해제 상태: 조회 실패 · ${errorText(error)}`);}
 const home=dirname(paths.state);lines.push(readable('session_index',join(home,'session_index.jsonl')),jsonFile('global_state',join(home,'.codex-global-state.json')));
 lines.push('권한: 읽기 검사만 수행; 쓰기/삭제 권한과 DB 전체 무결성은 미검증','codex_protocol_registration: 이 OS의 등록 검사 미구현 · 앱 열기 성공을 뜻하지 않음','Codex 앱 창·앱 업데이트: 미검증 (서버 연결·프로토콜 등록과 별도)');return lines.join('\n');
}
