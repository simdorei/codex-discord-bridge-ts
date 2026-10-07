import {readFileSync,writeFileSync} from 'node:fs';
const rows=readFileSync(new URL('stdout.log',import.meta.url),'utf8').trim().split(/\r?\n/).map(JSON.parse);
const result={scope:'Derived rendering of exact completed parent-authored Rust oracle stdout only',meta:rows.filter(x=>x.meta),cases:rows.filter(x=>!x.meta).map(x=>({...x,...(x.ok?{codePoints:Array.from(x.value,c=>c.codePointAt(0).toString(16))}:{})}))};
writeFileSync(new URL('decoded-results.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result.cases.filter(x=>x.encoding==='UTF-16le').map(({index,ok,codePoints,error})=>({index,ok,codePoints,error}))));