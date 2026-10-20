import {joinRuntimePath} from './runtime-paths/path-text.ts';
import {replaceWindowsFileSync} from './windows/windows-file.ts';
import {constants,readFileSync,readSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,lstatSync,unlinkSync,fstatSync} from "node:fs";
import {dirname} from "node:path";
import {randomUUID} from "node:crypto";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {serializePrettySerdeValue} from "../core/serde-json-pretty.ts";
import {getOwn,asJsonObject} from "../store/async-resolution-json-helpers.ts";
import {trimUnicodeWhitespace} from "../store/queue-preflight-failure.ts";
export interface SavedThreadSettings {model:string|null;reasoning:string|null;speed:string|null}
export class BridgeStateError extends Error{
  readonly kind:"Io"|"Json"|"NotObject";readonly path:string;
  constructor(kind:"Io"|"Json"|"NotObject",path:string,cause?:unknown){
    const reason=cause instanceof Error?cause.message:String(cause);
    super(kind==="Io"?`could not access bridge state ${path}: ${reason}`:kind==="Json"?`bridge state ${path} is not valid JSON: ${reason}`:`bridge state did not contain a JSON object: ${path}`,{cause});
    this.name="BridgeStateError";this.kind=kind;this.path=path;
  }
}
const isObject=(value:unknown):value is Record<string,unknown>=>asJsonObject(value)!==undefined;
const text=(v:unknown):string=>{if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed bridge state text");return v;};
const clean=(v:unknown):string|null=>typeof v==="string"?(trimUnicodeWhitespace(v)||null):null;
function put(record:Record<string,unknown>,key:string,value:unknown):void{Object.defineProperty(record,key,{value,writable:true,enumerable:true,configurable:true});}
function objectEntry(record:Record<string,unknown>,key:string):Record<string,unknown>{
  const old=getOwn(record,key);if(isObject(old))return old;const next=Object.create(null) as Record<string,unknown>;put(record,key,next);return next;
}
/** Single-execution-context state owner. Synchronous operations contain no await/interleaving.
 * Must live in the eventual owned filesystem worker, not a latency-sensitive event handler. */
export class BridgeState {
  readonly #path:string;readonly #maxBytes:number|undefined;
  constructor(path:string,maxBytes?:number){if(maxBytes!==undefined&&(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1048576))throw new RangeError("Invalid bridge state budget");this.#path=text(path);this.#maxBytes=maxBytes;}
  path():string{return this.#path;}
  selectedThreadId():string|null{return clean(getOwn(this.#load(),"selected_thread_id"));}
  selectedThreadIdBounded(maxBytes:number):string|null{if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1048576)throw new RangeError("Invalid bridge read budget");return clean(getOwn(this.#load(maxBytes),"selected_thread_id"));}
  trackedThreadIds():string[]{
    const state=this.#load(),ids=new Set<string>(),selected=clean(getOwn(state,"selected_thread_id"));if(selected!==null)ids.add(selected);
    const settings=getOwn(state,"thread_settings");if(isObject(settings))for(const key of Object.keys(settings))if(key!=="")ids.add(key);
    return [...ids].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  }
  setSelectedThreadId(id:string|null):void{
    if(id!==null)text(id);this.#update(state=>{const next=clean(id);if(next===null)delete state.selected_thread_id;else put(state,"selected_thread_id",next);});
  }
  /** Single owner operation: no await between scope check and selected clear. */
  clearSelectedIfInScope(scope:readonly string[]):boolean{
    for(const id of scope)text(id);const state=this.#load(),selected=clean(getOwn(state,"selected_thread_id"));
    if(selected===null||!scope.includes(selected))return false;delete state.selected_thread_id;this.#save(state);return true;
  }
  threadSettings(id:string):SavedThreadSettings{
    text(id);const settings=getOwn(getOwn(this.#load(),"thread_settings"),id);
    return {model:clean(getOwn(settings,"model")),reasoning:clean(getOwn(settings,"reasoning")),speed:clean(getOwn(settings,"speed"))};
  }
  rememberThreadSettings(id:string,model:string|null,reasoning:string|null,speed:string|null):void{
    text(id);for(const value of [model,reasoning,speed])if(value!==null)text(value);
    if(model===null&&reasoning===null&&speed===null)return;
    this.#update(state=>{const settings=objectEntry(objectEntry(state,"thread_settings"),id);
      for(const [key,value] of [["model",model],["reasoning",reasoning],["speed",speed]] as const)if(value!==null)put(settings,key,value);
    });
  }
  applyThreadFork(source:string,target:string):void{
    text(source);text(target);if(source===target)return;
    this.#update(state=>{if(clean(getOwn(state,"selected_thread_id"))===source)put(state,"selected_thread_id",target);
      const all=objectEntry(state,"thread_settings");if(!Object.hasOwn(all,target)&&Object.hasOwn(all,source))put(all,target,getOwn(all,source));
    });
  }
  #update(mutate:(state:Record<string,unknown>)=>void):void{const state=this.#load();mutate(state);this.#save(state);}
  #load(maxBytes:number|undefined=this.#maxBytes):Record<string,unknown>{
    let bytes:Buffer;
    try{if(maxBytes===undefined)bytes=readFileSync(this.#path);else{const fd=openSync(this.#path,constants.O_RDONLY|constants.O_NONBLOCK);try{if(!fstatSync(fd).isFile())throw new TypeError('Expected regular bridge state file');const buffer=Buffer.alloc(maxBytes+1);let used=0;while(used<buffer.length){const n=readSync(fd,buffer,used,buffer.length-used,null);if(n===0)break;used+=n;}if(used>maxBytes)throw new RangeError('Bridge state exceeds byte budget');bytes=buffer.subarray(0,used);}finally{closeSync(fd);}}}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return Object.create(null);throw new BridgeStateError("Io",this.#path,error);}
    if(bytes.length>=3&&bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf)bytes=bytes.subarray(3);
    let value:unknown;try{value=parseSerdeValue(new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes));}catch(error){throw new BridgeStateError("Json",this.#path,error);}
    if(!isObject(value))throw new BridgeStateError("NotObject",this.#path);return value;
  }
  #save(state:Record<string,unknown>):void{
    const parent=dirname(this.#path);try{mkdirSync(parent,{recursive:true});}catch(error){throw new BridgeStateError("Io",this.#path,error);}
    let bytes:string;try{bytes=serializePrettySerdeValue(state)+'\n';if(this.#maxBytes!==undefined&&Buffer.byteLength(bytes)>this.#maxBytes)throw new RangeError('Bridge state exceeds write budget');}catch(error){throw new BridgeStateError("Json",this.#path,error);}
    const temporary=joinRuntimePath(parent,`.cdr-state-${randomUUID()}.tmp`,process.platform==='win32'?'win32':'posix');let fd:number|undefined,identity:ReturnType<typeof fstatSync>|undefined,renamed=false;
    try{fd=openSync(temporary,"wx",0o600);identity=fstatSync(fd);writeFileSync(fd,bytes,"utf8");fsyncSync(fd);closeSync(fd);fd=undefined;if(process.platform==='win32')replaceWindowsFileSync(temporary,this.#path);else renameSync(temporary,this.#path);renamed=true;}
    catch(error){throw new BridgeStateError("Io",this.#path,error);}
    finally{
      if(fd!==undefined){try{closeSync(fd);}catch{/* preserve primary write error */}}
      if(!renamed&&identity!==undefined){try{const found=lstatSync(temporary);if(!found.isSymbolicLink()&&found.dev===identity.dev&&found.ino===identity.ino)unlinkSync(temporary);}catch{/* preserve primary error, never remove an unverified path */}}
    }
  }
}
