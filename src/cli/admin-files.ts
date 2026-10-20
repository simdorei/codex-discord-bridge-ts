import {open,stat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {writeWindowsAtomicFile} from '../runtime/windows/windows-atomic-file.ts';
import {WindowsFilePin} from '../runtime/windows/windows-file-pin.ts';
export async function boundedAdminRead(path:string,limit=1048576):Promise<Buffer>{
 path=resolve(path);
 await stat(path);
 const pin=process.platform==='win32'?WindowsFilePin.acquire(path,'file'):undefined;
 let file;try{file=await open(path,'r');if(!(await file.stat()).isFile())throw new Error('Admin input is not a regular file');const bytes=Buffer.alloc(limit+1);let size=0;for(;;){const r=await file.read(bytes,size,bytes.length-size,null);size+=r.bytesRead;if(size>limit)throw new Error('Admin input exceeds its byte bound');if(r.bytesRead===0)return bytes.subarray(0,size);}}finally{try{await file?.close();}finally{pin?.close();}}
}
export const decodeAdminText=(bytes:Uint8Array)=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
export async function updateAdminEnvironment(root:string,updates:Readonly<Record<string,string>>):Promise<void>{
 const path=join(root,'.env');let text='';try{text=decodeAdminText(await boundedAdminRead(path));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 for(const [key,value] of Object.entries(updates))if(!/^[A-Z][A-Z0-9_]*$/.test(key)||/[\r\n\0]/.test(value))throw new Error('Invalid environment update');
 const pending=new Map(Object.entries(updates)),seen=new Set<string>(),lines=text.replace(/^\uFEFF/,'').split(/\r?\n/),out:string[]=[];
 for(const line of lines){const key=/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];if(key!==undefined&&pending.has(key)){if(!seen.has(key))out.push(key+'='+pending.get(key));seen.add(key);}else out.push(line);}
 while(out.at(-1)==='')out.pop();for(const [key,value]of pending)if(!seen.has(key))out.push(key+'='+value);
 if(process.platform!=='win32')throw new Error('Atomic install environment updates currently require Windows');
 await writeWindowsAtomicFile(path,out.join('\r\n')+'\r\n');
}
export async function verifyInstallInventory(root:string,marketplaces:string,plugins:string,manifest:string,name:string,id:string):Promise<string>{
 const object=async(path:string)=>{const value=JSON.parse(decodeAdminText(await boundedAdminRead(path)).replace(/^\uFEFF/,''));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Inventory must be a JSON object');return value;};
 const [markets,installed,expected]=await Promise.all([object(marketplaces),object(plugins),object(manifest)]);
 const single=(items:unknown,key:string,value:string)=>{if(!Array.isArray(items)||items.some(v=>!v||typeof v!=='object'||Array.isArray(v)))throw new Error('Invalid inventory array');const matches=items.filter(v=>v[key]===value);if(matches.length!==1)throw new Error('Inventory identity is not unique');return matches[0];};
 const market=single(markets.marketplaces,'name',name),plugin=single(installed.installed,'pluginId',id);
 const actual=await realpath(market.root),wanted=await realpath(root),normalize=(s:string)=>process.platform==='win32'?s.toLowerCase():s;
 if(normalize(actual)!==normalize(wanted))throw new Error('Marketplace points to another installation');
 if(typeof expected.version!=='string'||expected.version===''||plugin.version!==expected.version||plugin.installed!==true||plugin.enabled!==true)throw new Error('Plugin is missing, disabled or has a different version');return expected.version;
}
