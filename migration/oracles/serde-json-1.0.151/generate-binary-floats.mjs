import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const here=resolve(import.meta.dirname);
const binary=resolve(here,'../../.cargo-build/debug/migration-serde-json-oracle.exe');
const bits=[];let seed=0x123456789abcdef0n;const mask=(1n<<64n)-1n;
const add=x=>{if(((x>>52n)&0x7ffn)!==0x7ffn)bits.push(x.toString(16).padStart(16,'0'))};
for(const v of [0n,1n,2n,0x8000000000000000n,0x000fffffffffffffn,0x0010000000000000n,0x7fefffffffffffffn])add(v);
const view=new DataView(new ArrayBuffer(8));
for(const n of [1e-5,1e-6,1e15,1e16,1e21,0.1,1,Number.MIN_VALUE,Number.MAX_VALUE]){view.setFloat64(0,n);const b=view.getBigUint64(0);for(let delta=-16n;delta<=16n;delta++){const x=b+delta;if(x>=0n&&x<=mask){add(x);add(x|0x8000000000000000n)}}}
for(let i=0;i<20000;i++){seed^=seed<<13n;seed&=mask;seed^=seed>>7n;seed^=seed<<17n;seed&=mask;add(seed)}
const unique=[...new Set(bits)];const input=unique.map(x=>'bits:'+x).join('\n')+'\n';
writeFileSync(join(here,'binary-float-fixtures.ndjson'),input);
const run=spawnSync(binary,[],{input,encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024,windowsHide:true});
writeFileSync(join(here,'binary-float-golden.ndjson'),run.stdout??'');writeFileSync(join(here,'binary-float.stderr.txt'),run.stderr??'');
const report={seed:'123456789abcdef0',randomIterations:20000,finiteUniqueFixtures:unique.length,exitCode:run.status,error:run.error?.message??null,oracleBinary:binary};writeFileSync(join(here,'binary-float-oracle-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(run.status!==0)process.exitCode=1;