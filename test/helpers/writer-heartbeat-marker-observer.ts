/** Owned stdio-only observer. All timestamps belong to this process. */
import {readFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {createInterface} from 'node:readline';
const marker=process.argv[2];
if(process.argv.length!==3||!marker)throw new Error('Expected exact marker path');
let stopped=false,sequence=0;
const commands=createInterface({input:process.stdin});
commands.on('line',line=>{if(line==='STOP')stopped=true;else{process.exitCode=2;stopped=true;}});
commands.on('close',()=>{stopped=true;});
function send(value:unknown):Promise<void>{return new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(value)+'\n',error=>error?reject(error):resolve()));}
await send({kind:'ready'});
try{while(!stopped){const started=performance.now();let sample:object;
 try{const text=await readFile(marker,'utf8');sample={kind:'sample',text};}
 catch(error){const code=error!==null&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code')?.value:undefined;sample={kind:code==='ENOENT'?'absent':'error',code:typeof code==='string'?code:'unknown'};}
 await send({...sample,sequence:++sequence,started,ended:performance.now()});
 if(!stopped)await sleep(25);
}}finally{commands.close();await send({kind:'stopped',sequence});}
