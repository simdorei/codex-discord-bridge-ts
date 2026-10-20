import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,join} from 'node:path';
import {writeFile,readFile} from 'node:fs/promises';
import {storeFixture} from '../helpers/store-fixture.ts';
import {RemoteProjectDispatcher} from '../../src/remote-agent/project-dispatcher.ts';
import {parseGatewayCommand} from '../../src/remote-agent/gateway-command.ts';
import {openNativeRemoteProject} from '../../src/remote-agent/native-project.ts';
import {encodeWindowsBitmapPng} from '../../src/runtime/windows/png.ts';

for(const kind of ['save_image','file_create','patch_cas','patch_destination'])test('native '+kind+' pre-mutation conflict leaves the same session writable',{skip:process.platform!=='win32',timeout:15000},()=>storeFixture(async path=>{
 const root=dirname(path),png=encodeWindowsBitmapPng(1,1,Buffer.from([0,0,255,255]));
 await writeFile(join(root,'existing.png'),png);await writeFile(join(root,'existing.txt'),'original');
 const now=()=>({seconds:BigInt(Math.floor(Date.now()/1000)),nanosecond:0n});
 const owner=new RemoteProjectDispatcher({openProject:p=>openNativeRemoteProject(p,process.execPath),nowUtc:now,nowMonotonic:()=>process.hrtime.bigint(),maxResultBytes:12000000});
 const command=(type:string,extra:object={})=>parseGatewayCommand(JSON.stringify({type,request_id:type,thread_id:'fixture',computer_session_id:'fixture-session-12345678',deadline_at:new Date(Date.now()+60000).toISOString(),...extra}),12000000);
 const signal=new AbortController().signal;
 try{
  await owner.upsert(Object.freeze({threadId:'fixture',root,expiresAt:Object.freeze({...now(),seconds:now().seconds+300n})}));
  const connection=await owner.beginConnection(1n);
  assert.equal((await owner.execute(command('project_session',{computer_session_generation:1}),connection,signal)).type,'project_session_result');
  const operation=kind==='save_image'?{kind,path:'existing.png',data_base64:png.toString('base64'),overwrite:false}:kind==='file_create'?{kind,path:'existing.txt',content:'refused',overwrite:false}:kind==='patch_cas'?{kind:'file_apply_patch',changes:[{action:'update',path:'existing.txt',content:'refused',expected_sha256:'0'.repeat(64)}]}:{kind:'file_apply_patch',changes:[{action:'move',path:'existing.txt',destination:'existing.png',expected_sha256:'0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5'}]};
  const refused=await owner.execute(command('project_operation',{request_id:'refused',operation}),connection,signal);
  assert.equal(refused.type,'operation_error');if(refused.type==='operation_error')assert.equal(refused.error_code,'fileconflict');
  assert.equal((await owner.execute(command('write_file',{request_id:'next',path:'next.txt',content:'still writable',expected_sha256:null}),connection,signal)).type,'write_file_result');
  assert.equal(await readFile(join(root,'next.txt'),'utf8'),'still writable');assert.equal(await readFile(join(root,'existing.txt'),'utf8'),'original');assert.deepEqual(await readFile(join(root,'existing.png')),png);
 }finally{await owner.close();}
}));
