import {openSync,closeSync,fstatSync,lstatSync,readSync,type BigIntStats} from 'node:fs';
export interface LegacyFileEvidence {status:string;stamp?:string;path?:string;contentsVerified?:false;bytesRead?:number;}
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.birthtimeNs,s.mtimeNs,s.ctimeNs,s.size].join(':');
function open(path:string):number|undefined{
 try{return openSync(path,'r');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
}
function missing(path:string):void{
 try{lstatSync(path);}
 catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 throw new Error('Plain legacy source appeared during compressed inspection');
}
export function inspectLegacyFile(path:string,cursor:bigint|undefined,check:()=>void):LegacyFileEvidence{
 check();const fd=open(path);if(fd===undefined)return {status:'Missing'};
 try{
  const s=fstatSync(fd,{bigint:true}),before=stamp(s);let status:string,bytesRead=0;
  if(!s.isFile())status='NotFile';else if(cursor===undefined)status='Exists';
  else if(cursor<0n||cursor>s.size)status='OutOfRange';else if(cursor===0n)status='LFAligned';
  else if(cursor>BigInt(Number.MAX_SAFE_INTEGER))status='OffsetBudgetExceeded';
  else{const byte=Buffer.alloc(1);bytesRead=readSync(fd,byte,0,1,Number(cursor-1n));status=bytesRead!==1?'ReadUnconfirmed':byte[0]===10?'LFAligned':'NonRecordBoundary';}
  check();if(stamp(fstatSync(fd,{bigint:true}))!==before||stamp(lstatSync(path,{bigint:true}))!==before)throw new Error('Legacy file changed during inspection');
  return {status,stamp:before,bytesRead};
 }finally{closeSync(fd);check();}
}
/** A four-byte format candidate, never decompressed history or cursor proof. */
export function inspectLegacyCompressed(plain:string,check:()=>void):LegacyFileEvidence{
 check();missing(plain);const path=plain+'.zst',fd=open(path);if(fd===undefined)return {status:'Missing',path,contentsVerified:false,bytesRead:0};
 try{
  const s=fstatSync(fd,{bigint:true}),before=stamp(s),named=lstatSync(path,{bigint:true});
  if(!s.isFile()||named.isSymbolicLink()||!named.isFile()||stamp(named)!==before)throw new Error('Compressed legacy source identity unconfirmed');
  const header=Buffer.alloc(4),bytesRead=readSync(fd,header,0,4,0);check();
  if(stamp(fstatSync(fd,{bigint:true}))!==before||stamp(lstatSync(path,{bigint:true}))!==before)throw new Error('Compressed legacy source changed during inspection');
  missing(plain);return {status:bytesRead===4&&header.toString('hex')==='28b52ffd'?'CompressedCandidate':'InvalidCompressedHeader',stamp:before,path,contentsVerified:false,bytesRead};
 }finally{closeSync(fd);check();}
}
