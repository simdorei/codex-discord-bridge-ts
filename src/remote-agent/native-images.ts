import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {isIP,BlockList} from 'node:net';
import {extname} from 'node:path';
import type {RemoteOperationContext} from './dispatcher-ports.ts';
const MAX=5242880;
/** Validation completed before checkpoint creation or any filesystem mutation. */
export class RemoteImageInputError extends Error{constructor(message:string){super(message);this.name='RemoteImageInputError';}}
const blocked=new BlockList();
for(const [ip,prefix]of [['0.0.0.0',8],['10.0.0.0',8],['127.0.0.0',8],['100.64.0.0',10],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',16],['192.168.0.0',16],['198.18.0.0',15],['198.51.0.0',16],['203.0.0.0',16],['224.0.0.0',3]]as const)blocked.addSubnet(ip,prefix,'ipv4');
for(const [ip,prefix]of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['fec0::',10],['ff00::',8],['2001:db8::',32]]as const)blocked.addSubnet(ip,prefix,'ipv6');
export function isPublicImageAddress(address:string):boolean{const type=isIP(address);if(!type)return false;return !blocked.check(address,type===4?'ipv4':'ipv6')&&!blocked.check(address,'ipv4');}
export function imageEntry(path:string,bytes:Buffer){
 if(bytes.length>MAX)throw new RangeError('Image exceeds 5 MiB');const ext=extname(path).toLowerCase();let media_type:string|undefined;
 if(ext==='.png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))media_type='image/png';
 if(['.jpg','.jpeg'].includes(ext)&&bytes.subarray(0,3).equals(Buffer.from([255,216,255])))media_type='image/jpeg';
 if(ext==='.gif'&&['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()))media_type='image/gif';
 if(ext==='.webp'&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')media_type='image/webp';
 if(!media_type)throw new TypeError('Image extension and content signature differ');return Object.freeze({path,media_type,size_bytes:BigInt(bytes.length)});
}
/** Public HTTPS only, all DNS answers checked and selected addresses pinned to
 * the socket. Redirects are revalidated; no ambient proxy or credentials. */
export async function downloadRemoteImage(input:string,context:RemoteOperationContext):Promise<Buffer>{
 let current=new URL(input);const signal=AbortSignal.any([context.signal,AbortSignal.timeout(Math.max(1,Math.min(30000,Number(context.budget.remaining()/1000000n))))]);
 for(let redirects=0;redirects<=5;redirects++){
  signal.throwIfAborted();if(current.protocol!=='https:'||current.username||current.password||current.port&&current.port!=='443')throw new Error('Image URL requires public HTTPS on port 443');
  const host=current.hostname.replace(/^\[|\]$/g,''),addresses=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});signal.throwIfAborted();
  if(!addresses.length||addresses.some(a=>!isPublicImageAddress(a.address)))throw new Error('Image URL is not on the public network');
  let joined:Promise<void>|undefined;const pending=new Promise<Buffer|URL>((resolve,reject)=>{
   const selected=addresses[0]!,req=request(current,{agent:false,signal,lookup:(_host,_options,callback)=>callback(null,selected.address,selected.family),timeout:5000},response=>{
    response.once('error',reject);
    if(response.statusCode!>=300&&response.statusCode!<400){const next=response.headers.location;response.destroy();if(!next){reject(new Error('Image redirect has no destination'));return;}try{resolve(new URL(next,current));}catch(error){reject(error);}return;}
    if(response.statusCode===undefined||response.statusCode<200||response.statusCode>=300){response.destroy();reject(new Error('Image download failed'));return;}
    if(Number(response.headers['content-length']??0)>MAX){response.destroy();reject(new RangeError('Image exceeds 5 MiB'));return;}
    let size=0;const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>MAX){response.destroy();reject(new RangeError('Image exceeds 5 MiB'));}else chunks.push(Buffer.from(chunk));});response.once('error',reject);response.once('aborted',()=>reject(new Error('Image response interrupted')));response.once('end',()=>resolve(Buffer.concat(chunks,size)));
   });joined=new Promise<void>(closed=>req.once('close',closed));req.once('timeout',()=>req.destroy(new Error('Image connection timed out')));req.once('error',reject);req.end();
  });
  let result:Buffer|URL;try{result=await pending;}finally{await joined;}
  if(Buffer.isBuffer(result))return result;current=result;
 }
 throw new Error('Image redirect limit exceeded');
}
