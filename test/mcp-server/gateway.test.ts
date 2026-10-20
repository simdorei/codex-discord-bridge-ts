import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {WebSocket} from 'ws';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as sleep} from 'node:timers/promises';
import {storeFixture} from '../helpers/store-fixture.ts';
import {gatewayConfig} from '../../src/mcp-server/config.ts';
import {OAuthStore} from '../../src/mcp-server/oauth-store.ts';
import {OAuthOwner} from '../../src/mcp-server/oauth-owner.ts';
import {startGateway} from '../../src/mcp-server/server.ts';
import {definitions,requiredScopes} from '../../src/mcp-server/tool-inventory.ts';
const owner='owner-fixture-'.repeat(3),deviceToken='device-fixture-'.repeat(3),resource='https://simdorei.duckdns.org/mcp',verifier='a'.repeat(50),challenge=createHash('sha256').update(verifier).digest('base64url');
const config=(path:string)=>gatewayConfig({SIMDOREI_MCP_PUBLIC_BASE_URL:'https://simdorei.duckdns.org',SIMDOREI_MCP_OWNER_TOKEN:owner,SIMDOREI_MCP_DEVICE_ID:'fixture',SIMDOREI_MCP_DEVICE_TOKEN:deviceToken,SIMDOREI_MCP_OAUTH_DATABASE_PATH:path,SIMDOREI_MCP_BIND:'127.0.0.1:0'});
test('OAuth asynchronous admission preserves single-use codes and refresh replay revocation',{timeout:15000},()=>storeFixture(async path=>{
 const worker=new OAuthOwner(config(path).oauth);await worker.ready();const db=new DatabaseSync(path);
 try{
  const client=await worker.call('register',{redirect_uris:['https://client.invalid/cb']}),pending=await worker.call('authorize',{response_type:'code',client_id:client.client_id,redirect_uri:'https://client.invalid/cb',code_challenge:challenge,code_challenge_method:'S256'});
  const code=new URL(await worker.call<string>('approve',{request_id:pending.request_id,owner_token:owner})).searchParams.get('code'),input={grant_type:'authorization_code',client_id:client.client_id,client_secret:client.client_secret,code,code_verifier:verifier,redirect_uri:'https://client.invalid/cb'};
  db.exec('BEGIN IMMEDIATE');const exchanges=Promise.allSettled([worker.call('token',input),worker.call('token',input)]);await sleep(75);db.exec('ROLLBACK');const results=await exchanges;
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.match(rejected.reason.message,/invalid_grant/);assert.equal(db.prepare('SELECT count(*) n FROM oauth_tokens').get()!.n,2);
  const tokens=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value,refresh={grant_type:'refresh_token',client_id:client.client_id,client_secret:client.client_secret,refresh_token:tokens.refresh_token};
  db.exec('BEGIN IMMEDIATE');const rotations=Promise.allSettled([worker.call('token',refresh),worker.call('token',refresh)]);await sleep(75);db.exec('ROLLBACK');const rotated=await rotations;
  assert.equal(rotated.filter(r=>r.status==='fulfilled').length,1);assert.equal(rotated.filter(r=>r.status==='rejected').length,1);
  const next=(rotated.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value;assert.equal(await worker.call('access',{token:next.access_token}),null);assert.equal(db.prepare('SELECT count(*) n FROM oauth_tokens').get()!.n,0);
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();await worker.close();}
}));
test('OAuth shutdown joins waiting admissions without executing a delayed registration',{timeout:15000},()=>storeFixture(async path=>{
 const worker=new OAuthOwner(config(path).oauth);await worker.ready();const db=new DatabaseSync(path);
 try{
  db.exec('BEGIN IMMEDIATE');const pending=Promise.allSettled([worker.call('register',{redirect_uris:['https://client.invalid/cb']})]);await sleep(75);
  const began=Date.now();await worker.close();assert.ok(Date.now()-began<1500,'Shutdown must not wait for SQLite busy timeout');assert.equal((await pending)[0]!.status,'rejected');
  db.exec('ROLLBACK');assert.equal(db.prepare('SELECT count(*) n FROM oauth_clients').get()!.n,0);
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();await worker.close();}
}));
test('OAuth transaction failure retains an unused code and rolls back partial tokens',()=>storeFixture(async path=>{
 const store=new OAuthStore(config(path).oauth),run=(op:string,input:Record<string,unknown>)=>store.run(op,input) as any;
 try{const client=run('register',{redirect_uris:['https://client.invalid/cb']}),request=run('authorize',{response_type:'code',client_id:client.client_id,redirect_uri:'https://client.invalid/cb',code_challenge:challenge,code_challenge_method:'S256'}),code=new URL(run('approve',{request_id:request.request_id,owner_token:owner})).searchParams.get('code'),input={grant_type:'authorization_code',client_id:client.client_id,client_secret:client.client_secret,code,code_verifier:verifier,redirect_uri:'https://client.invalid/cb'};
  const db=new DatabaseSync(path);try{db.exec("CREATE TRIGGER reject_refresh BEFORE INSERT ON oauth_tokens WHEN NEW.token_kind='refresh' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");assert.throws(()=>run('token',input),/fixture rollback/);assert.equal(db.prepare('SELECT count(*) n FROM oauth_tokens').get()!.n,0);db.exec('DROP TRIGGER reject_refresh');const tokens=run('token',input);assert.ok(tokens.access_token);assert.throws(()=>run('token',input),/invalid_grant/);}finally{db.close();}
 }finally{store.close();}
}));
test('OAuth preserves code/PKCE binding, durable token rotation, replay revocation and bounded approvals',()=>storeFixture(async path=>{
 let now=1000;const c=config(path).oauth,store=new OAuthStore(c,()=>now),run=(op:string,v:Record<string,unknown>={})=>store.run(op,v) as any;
 try{
  const client=run('register',{redirect_uris:['https://client.invalid/cb'],scope:'files:read'}),request={response_type:'code',client_id:client.client_id,redirect_uri:client.redirect_uris[0],resource,code_challenge_method:'S256',code_challenge:challenge,scope:'files:read'};
  assert.throws(()=>run('authorize',{...request,redirect_uri:'https://evil.invalid/cb'}),/invalid_request/);assert.throws(()=>run('authorize',{...request,scope:'files:write'}),/invalid_scope/);
  const pending=run('authorize',request);for(let i=0;i<5;i++)assert.throws(()=>run('approve',{request_id:pending.request_id,owner_token:'wrong'}),/approval_denied/);assert.throws(()=>run('approve',{request_id:pending.request_id,owner_token:owner}),/approval_expired/);
  const next=run('authorize',request),code=new URL(run('approve',{request_id:next.request_id,owner_token:owner})).searchParams.get('code'),exchange={grant_type:'authorization_code',client_id:client.client_id,client_secret:client.client_secret,code,redirect_uri:request.redirect_uri,resource,code_verifier:verifier};
  assert.throws(()=>run('token',{...exchange,code_verifier:'z'.repeat(50)}),/invalid_grant/);const tokens=run('token',exchange);assert.throws(()=>run('token',exchange),/invalid_grant/);assert.equal(run('access',{token:tokens.access_token}).subject,'owner');
  const refresh={grant_type:'refresh_token',client_id:client.client_id,client_secret:client.client_secret,refresh_token:tokens.refresh_token,resource};assert.throws(()=>run('token',{...refresh,scope:'files:write'}),/invalid_scope/);
  const rotated=run('token',refresh);assert.equal(run('access',{token:tokens.access_token}),null);assert.ok(run('access',{token:rotated.access_token}));assert.throws(()=>run('token',refresh),/invalid_grant/);assert.equal(run('access',{token:rotated.access_token}),null);
  const expiring=run('authorize',request);now+=301;assert.equal(run('pending',{request_id:expiring.request_id}),null);
 }finally{store.close();}
 const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM oauth_refresh_history').get()!.n,1);assert.equal(db.prepare('SELECT count(*) n FROM oauth_tokens').get()!.n,0);}finally{db.close();}
}));
test('HTTP OAuth + MCP + protocol-10 WebSocket keep unrelated threads concurrent and reject scope/origin violations',{timeout:30000},()=>storeFixture(async path=>{
 const c=config(path),gateway=await startGateway(c),address=gateway.address as {port:number},base='http://127.0.0.1:'+address.port;let ws:WebSocket|undefined;
 const post=async(endpoint:string,input:Record<string,unknown>,json=false)=>fetch(base+endpoint,{method:'POST',headers:{'content-type':json?'application/json':'application/x-www-form-urlencoded'},body:json?JSON.stringify(input):new URLSearchParams(Object.entries(input).map(([k,v])=>[k,String(v)])).toString(),redirect:'manual'});
 try{
  assert.equal((await fetch(base+'/mcp')).status,401);assert.equal((await fetch(base+'/healthz',{headers:{Origin:'https://evil.invalid'}})).status,403);
  const client=await (await post('/register',{redirect_uris:['https://client.invalid/cb']},true)).json() as any;
  const authorize=await fetch(base+'/authorize?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:'https://client.invalid/cb',code_challenge:challenge,code_challenge_method:'S256',resource}),{redirect:'manual'});assert.equal(authorize.status,303);
  const requestId=new URL(authorize.headers.get('location')!).searchParams.get('request_id'),approval=await post('/oauth/approve',{request_id:requestId,owner_token:owner});assert.equal(approval.status,303);
  const code=new URL(approval.headers.get('location')!).searchParams.get('code'),tokens=await (await post('/token',{grant_type:'authorization_code',client_id:client.client_id,client_secret:client.client_secret,code,redirect_uri:'https://client.invalid/cb',code_verifier:verifier,resource})).json() as any;assert.ok(tokens.access_token);
  const headers={authorization:'Bearer '+tokens.access_token,'content-type':'application/json',accept:'application/json, text/event-stream'};let request=0;
  const rpc=async(method:string,params:unknown)=>{const response=await fetch(base+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:++request,method,params})});assert.equal(response.status,200);return response.json() as Promise<any>;};
  assert.equal((await rpc('initialize',{protocolVersion:'2025-11-25'})).result.protocolVersion,'2025-11-25');const listed=(await rpc('tools/list',{})).result.tools;assert.equal(listed.length,51);assert.equal(new Set(listed.map((x:any)=>x.name)).size,51);for(const definition of definitions)assert.ok(requiredScopes(String(definition.name)));
  const call=(name:string,session:string,args:Record<string,unknown>={})=>rpc('tools/call',{name,arguments:args,_meta:{'openai/session':session}});
  assert.equal((await rpc('tools/call',{name:'list_devices'})).result.isError,true);
  ws=new WebSocket(base.replace('http:','ws:')+'/bridge',{headers:{authorization:'Bearer '+deviceToken}});await once(ws,'open');
  const seen:any[]=[],waiting=new Map<string,()=>void>();let held:any;
  ws.on('message',bytes=>{const value=JSON.parse(bytes.toString());seen.push(value);waiting.get(value.type)?.();if(value.type==='project_session')ws!.send(JSON.stringify({type:'project_session_result',request_id:value.request_id}));if(value.type==='project_info'){if(value.thread_id==='thread-a')held=value;else ws!.send(JSON.stringify({type:'project_info_result',request_id:value.request_id,output:{root:'C:/fixture/b',thread_id:value.thread_id}}));}});
  const observed=(type:string)=>seen.some(m=>m.type===type)?Promise.resolve():new Promise<void>(resolve=>waiting.set(type,resolve));
  ws.send(JSON.stringify({type:'hello',protocol_version:10,device_id:'fixture'}));await observed('hello_ack');
  for(const letter of ['a','b'])ws.send(JSON.stringify({type:'project_upsert',project_scope:'scope-project-'+letter,binding_id:'binding-project-'+letter,thread_id:'thread-'+letter,project_name:letter,expires_at:new Date(Date.now()+3600000).toISOString()}));await observed('project_ack');
  for(const letter of ['a','b'])assert.equal((await call('select_project','conversation-'+letter,{project_scope:'scope-project-'+letter,connector_resource:resource})).result.isError,false);
  const a=call('project_info','conversation-a');await observed('project_info');assert.ok(held);const b=await call('project_info','conversation-b');assert.equal(b.result.structuredContent.thread_id,'thread-b');
  ws.send(JSON.stringify({type:'project_info_result',request_id:held.request_id,output:{root:'C:/fixture/a',thread_id:'thread-a'}}));assert.equal((await a).result.structuredContent.thread_id,'thread-a');
  // The SQLite writer can wait without blocking health or another HTTP client.
  const db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');const registration=post('/register',{redirect_uris:['https://another.invalid/cb']},true);let authenticated:Promise<any>|undefined,readProgress=false;
  try{await sleep(75);const began=Date.now();assert.equal((await fetch(base+'/healthz')).status,200);assert.ok(Date.now()-began<1500);authenticated=rpc('ping',{});readProgress=await Promise.race([authenticated.then(()=>true),sleep(600).then(()=>false)]);}
  finally{db.exec('ROLLBACK');db.close();await authenticated;}
  assert.equal((await registration).status,201);assert.equal(readProgress,true,'A locked OAuth writer must not block another authenticated MCP call');
  const refresh=await post('/token',{grant_type:'refresh_token',client_id:client.client_id,client_secret:client.client_secret,refresh_token:tokens.refresh_token,resource,scope:'files:read'}),limited=await refresh.json() as any;
  const denied=await fetch(base+'/mcp',{method:'POST',headers:{...headers,authorization:'Bearer '+limited.access_token},body:JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/call',params:{name:'write_project_file',arguments:{path:'x',content:'y'},_meta:{'openai/session':'conversation-a'}}})});assert.match(JSON.stringify(await denied.json()),/files:write/u);
 }finally{ws?.terminate();await gateway.close();}
}));
