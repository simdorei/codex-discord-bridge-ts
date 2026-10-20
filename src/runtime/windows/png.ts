import {deflateSync} from 'node:zlib';
const table=Uint32Array.from({length:256},(_,n)=>{let x=n;for(let i=0;i<8;i++)x=x&1?0xedb88320^(x>>>1):x>>>1;return x>>>0;});
function chunk(type:string,data:Buffer){const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const b of body)crc=table[(crc^b)&255]!^(crc>>>8);const result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);body.copy(result,4);result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;}
export function encodeWindowsBitmapPng(width:number,height:number,bgra:Buffer):Buffer{
 if(width<1||height<1||width>4096||height>4096||width*height>8294400||bgra.length!==width*height*4)throw new RangeError('Capture exceeds pixel budget');
 const raw=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++)for(let x=0;x<width;x++){const src=(y*width+x)*4,dst=y*(width*4+1)+1+x*4;raw[dst]=bgra[src+2]!;raw[dst+1]=bgra[src+1]!;raw[dst+2]=bgra[src]!;raw[dst+3]=255;}
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 const result=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);if(result.length>8500000)throw new RangeError('Capture exceeds PNG budget');return result;
}
