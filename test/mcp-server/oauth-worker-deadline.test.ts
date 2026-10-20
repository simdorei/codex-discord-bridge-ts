import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker,MessageChannel} from 'node:worker_threads';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {gatewayConfig} from '../../src/mcp-server/config.ts';

// Import the real worker unchanged. Only its monotonic clock and retry timer
// are controlled, so scheduler lateness is deterministic without a 5s sleep.
const harness=`
const {parentPort,workerData}=require('node:worker_threads');
const {mock}=require('node:test');
const control=workerData.clockControl;let now=0;
Object.defineProperty(globalThis,'performance',{value:{now:()=>now}});
mock.timers.enable({apis:['setTimeout']});
parentPort.on('message',message=>setImmediate(()=>control.postMessage({processed:message.id})));
control.on('message',message=>{now=message.time;mock.timers.tick(message.tick);});
import(workerData.moduleUrl).catch(error=>{throw error;});
`;
for(const elapsed of [4999,5000,6000])test('OAuth retry admission at '+elapsed+' ms respects its deadline',{timeout:15000},()=>storeFixture(async path=>{
 const cfg=gatewayConfig({SIMDOREI_MCP_PUBLIC_BASE_URL:'https://fixture.invalid',SIMDOREI_MCP_OWNER_TOKEN:'owner-fixture-'.repeat(3),SIMDOREI_MCP_DEVICE_ID:'fixture',SIMDOREI_MCP_DEVICE_TOKEN:'device-fixture-'.repeat(3),SIMDOREI_MCP_OAUTH_DATABASE_PATH:path,SIMDOREI_MCP_BIND:'127.0.0.1:0'});
 const control=new MessageChannel(),moduleUrl=new URL('../../src/mcp-server/oauth-worker.js',import.meta.url).href;
 const worker=new Worker(harness,{eval:true,workerData:{...cfg.oauth,clockControl:control.port2,moduleUrl},transferList:[control.port2]});let db:DatabaseSync|undefined;
 try{
  assert.deepEqual((await once(worker,'message'))[0],{ready:true});db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');
  const response=once(worker,'message'),queued=once(control.port1,'message');
  worker.postMessage({id:1,operation:'register',input:{redirect_uris:['https://client.invalid/cb']}});
  assert.equal((await queued)[0].processed,1);
  // This acknowledgement follows the production message handler yielding on
  // its retry timer. Free the writer before waking it at the controlled time.
  db.exec('ROLLBACK');control.port1.postMessage({time:elapsed,tick:25});const result=(await response)[0];
  if(elapsed<5000){assert.equal(result.ok,true);assert.equal(db.prepare('SELECT count(*) n FROM oauth_clients').get()!.n,1);}
  else{assert.equal(result.ok,false,'Expired admission must not create a client');assert.equal(result.code,'temporarily_unavailable');assert.equal(db.prepare('SELECT count(*) n FROM oauth_clients').get()!.n,0);}
 }finally{if(db?.isTransaction)db.exec('ROLLBACK');db?.close();await worker.terminate();control.port1.close();}
}));
