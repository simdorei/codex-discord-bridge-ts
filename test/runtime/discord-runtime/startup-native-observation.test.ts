import test from 'node:test';import assert from 'node:assert/strict';import {existsSync,readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {startRuntimeResident} from '../../../src/runtime/discord-runtime/resident-startup.ts';import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
function config(log:string){const code=`import readline from 'node:readline';import {appendFileSync} from 'node:fs';readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized')return;if(m.method!=='initialize')appendFileSync(${JSON.stringify(log)},line+'\\n');process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});`;return {process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'native-startup',title:'Fixture',version:'1'}};}
async function until(check:()=>boolean){const deadline=Date.now()+4000;while(!check()){if(Date.now()>deadline)throw Error('fixture condition not observed');await new Promise(resolve=>setTimeout(resolve,5));}}

async function verify(closeDuring:boolean){await storeFixture(async path=>{
 const r=await startRuntimeResident(config(path+'.wire'),path,'runtime',null,()=> 'safe'),db=await openInitialized(path);let pending:Promise<boolean>|undefined,closing:Promise<void>|undefined;
 try{
  db.exec('BEGIN EXCLUSIVE');let settled=false;pending=r.reconcileIdleObservationPrefixAsync(1n,0n);void pending.then(()=>{settled=true;},()=>{settled=true;});
  await until(()=>ownedWorkerUsage().Observation===1);await new Promise(resolve=>setTimeout(resolve,40));assert.equal(settled,false);assert.equal(db.isTransaction,true);assert.equal(ownedWorkerUsage().Control,0);
  if(closeDuring){let closed=false;closing=r.close().then(()=>{closed=true;});await new Promise(resolve=>setTimeout(resolve,40));assert.equal(closed,false);}
  db.exec('ROLLBACK');assert.equal(await pending,!closeDuring);if(closing)await closing;assert.equal(ownedWorkerUsage().Observation,0);
 }finally{if(db.isTransaction)db.exec('ROLLBACK');await Promise.allSettled([pending,closing].filter(Boolean) as Promise<unknown>[]);await r.dispose();db.close();}
});}
test('actual startup native prefix read waits SQLite exclusive lock without blocking timers',async()=>verify(false));
test('actual startup close joins locked prefix read and refuses its late proof',async()=>verify(true));
