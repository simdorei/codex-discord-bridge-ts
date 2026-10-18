import {createRequire} from 'node:module';
import type {RestartHandoffProtector} from '../../remote-agent/restart-handoff-persistence.ts';
let native:((bytes:Uint8Array,decrypt:boolean)=>Buffer)|undefined;
/** Current-user DPAPI, with UI forbidden and no machine-wide key fallback. */
export function windowsDpapiProtector():RestartHandoffProtector {
 if(process.platform!=='win32'||!['x64','arm64'].includes(process.arch))throw new Error('DPAPI requires 64-bit Windows');
 if(native===undefined){
  const k=createRequire(import.meta.url)('koffi');if(k.version!=='3.3.3')throw new Error('Unsupported native dependency');
  k.struct('CDR_DATA_BLOB',{cbData:'uint32_t',pbData:'void *'});
  const crypt=k.load('crypt32.dll'),kernel=k.load('kernel32.dll');
  const protect=crypt.func('int32_t __stdcall CryptProtectData(CDR_DATA_BLOB *input, str16 description, void *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ CDR_DATA_BLOB *output)');
  const unprotect=crypt.func('int32_t __stdcall CryptUnprotectData(CDR_DATA_BLOB *input, void *description, void *entropy, void *reserved, void *prompt, uint32_t flags, _Out_ CDR_DATA_BLOB *output)');
  const free=kernel.func('void * __stdcall LocalFree(void *pointer)');
  native=(bytes,decrypt)=>{
   if(!(bytes instanceof Uint8Array)||bytes.byteLength>1048576)throw new RangeError('DPAPI input exceeds budget');
   const input=Buffer.from(bytes),output:{cbData?:number;pbData?:bigint|null}={};
   try{
    const ok=(decrypt?unprotect:protect)({cbData:input.length,pbData:input},null,null,null,null,1,output);
    if(ok===0)throw new Error('DPAPI operation failed');
    if(!Number.isSafeInteger(output.cbData)||output.cbData!>1048576||output.cbData!<0||!output.pbData)throw new Error('DPAPI output exceeds budget');
    const result=Buffer.from(k.decode(output.pbData,k.array('uint8_t',output.cbData)));return result;
   }finally{
    input.fill(0);
    if(output.pbData){try{if(decrypt&&Number.isInteger(output.cbData)&&output.cbData!>=0&&output.cbData!<=1048576)k.encode(output.pbData,k.array('uint8_t',output.cbData),Buffer.alloc(output.cbData!));}finally{if(free(output.pbData)!==null)throw new Error('DPAPI output release failed');}}
   }
  };
 }
 const transform=native;
 return Object.freeze({protect:(bytes:Uint8Array)=>transform(bytes,false),unprotect:(bytes:Uint8Array)=>transform(bytes,true)});
}
