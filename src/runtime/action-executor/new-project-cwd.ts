import {statSync} from 'node:fs';
import {CodexThreadStore} from '../../codex-state/store.ts';
import {stripWindowsExtendedPrefix} from '../../codex-state/thread-reference.ts';
import {parseSerdeStruct,type StructShape,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import type {NewThreadOrigin} from '../../store/new-thread-origin.ts';
import {joinRuntimePath} from '../runtime-paths/path-text.ts';
import {InvalidActionRequestError} from './errors.ts';
const byte:StructFieldDecoder=(_r,_d,c)=>{const v=c.decode('u64') as bigint;if(v>255n)throw new SyntaxError('Expected u8 origin version');return v;};
const optionalI64:StructFieldDecoder=(_r,_d,c)=>c.value()===null?null:c.decode('i64');
const SHAPE:StructShape={fields:[['version',byte],['channel','i64'],['target','string?'],['mapped_project','string?'],['parent_channel',optionalI64],['project','string?'],['parent_project','string?'],['chat_targets','string[]']],mapDefaults:{parent_channel:null}};
export function decodeNewThreadOrigin(value:unknown):NewThreadOrigin{return parseSerdeStruct(serializeSerdeValue(value),SHAPE) as unknown as NewThreadOrigin;}
function checkedCwd(input:string,base:string):string {
 const cwd=stripWindowsExtendedPrefix(input);let directory=false;try{directory=statSync(joinRuntimePath(base,cwd,process.platform==='win32'?'win32':'posix')).isDirectory();}catch{}
 if(!directory)throw new InvalidActionRequestError(`project directory is unavailable: ${cwd}`);return cwd;
}
export function resolveNewProjectCwd(statePath:string,origin:NewThreadOrigin,base=process.cwd()):string|null {
  if(origin.target!==null){const thread=CodexThreadStore.open(statePath).loadThread(origin.target,false);if(thread===null)throw new InvalidActionRequestError(`cannot resolve project of mapped thread ${origin.target}`);return checkedCwd(thread.cwd,base);}
  if(origin.project!==null){if(origin.project==='codex:chats'||origin.project.startsWith('projectless:')){const thread=CodexThreadStore.open(statePath).loadRecentThreads(0n).find(t=>origin.chat_targets.includes(t.id));if(thread===undefined)throw new InvalidActionRequestError('chat project has no known working directory');return checkedCwd(thread.cwd,base);}return checkedCwd(origin.project,base);}
  return null;
 }

export type NewProjectLookup=(path:string,origin:NewThreadOrigin,signal?:AbortSignal)=>Promise<string|null>;
export const directNewProjectLookup:NewProjectLookup=async(path,origin,signal)=>{signal?.throwIfAborted();return resolveNewProjectCwd(path,origin);};
