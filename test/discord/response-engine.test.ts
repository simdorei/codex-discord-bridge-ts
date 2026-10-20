import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {DiscordResponseEngine,type DiscordWireRequest,type DiscordWireResponse} from '../../src/discord/response-engine.ts';
import {idempotentMessageRequest} from '../../src/discord/idempotent-message.ts';
import {sendReceiptChunk} from '../../src/runtime/completion/receipt-sender.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
import {usingInitializedStore} from '../../src/store/owned-scope.ts';
const request=()=>idempotentMessageRequest(1n,'message','test','key',0);
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
function fixture(responses:readonly {status:number;body?:string;bytes?:Uint8Array}[],options:{decode?:(body:Uint8Array)=>bigint;token?:string|null}={}){
 const requests:DiscordWireRequest[]=[],events:string[]=[];let index=0,reads=0;
 const engine=new DiscordResponseEngine({token:options.token===undefined?'fixture-token':options.token,decoder:{decode:options.decode??(()=>91n)},rateLimiter:{acquire:async()=>{events.push('acquire');return {complete:s=>{events.push('complete:'+s);},release:()=>{events.push('permit-release');}};}},wire:{request:async(r,timeout)=>{assert.equal(timeout,10000);requests.push(r);events.push('request');const value=responses[index++]!;assert.ok(value);return {status:value.status,headers:new Map(),bytes:async()=>{reads++;events.push('body');return value.bytes??new TextEncoder().encode(value.body??'{}');},release:async()=>{events.push('response-release');}};}}});return {engine,requests,events,reads:()=>reads};
}
test('429 reacquires shared rate permission and preserves exact request bytes without reading rate error body',async()=>{
 const f=fixture([{status:429,body:'not-json'},{status:200}]);assert.equal(await f.engine.sendValidated(request()),91n);assert.equal(f.requests.length,2);assert.equal(f.requests[0],f.requests[1]);assert.equal(f.requests[0]!.authorization,'Bot fixture-token');assert.equal(f.reads(),1);assert.deepEqual(f.events,['acquire','request','complete:429','response-release','permit-release','acquire','request','complete:200','body','response-release','permit-release']);await f.engine.close();
});
test('non-429 errors never retry and require decoded ApiError before definite Response classification',async()=>{
 for(const body of ['not-json','null','[]']){const f=fixture([{status:400,body}]);await assert.rejects(f.engine.sendValidated(request()),/outcome is unconfirmed/);assert.equal(f.requests.length,1);await f.engine.close();}
 const f=fixture([{status:400,body:'{}'}]);await assert.rejects(f.engine.sendValidated(request()),/HTTP 400/);assert.equal(f.requests.length,1);await f.engine.close();
});
test('401 invalidates token before body decoding and future calls fail without rate admission',async()=>{
 const f=fixture([{status:401,body:'broken'}]);await assert.rejects(f.engine.sendValidated(request()),/unconfirmed/);assert.equal(f.engine.authorizationInvalidated,true);await assert.rejects(f.engine.sendValidated(request()),/authorization was invalidated/);assert.equal(f.requests.length,1);assert.equal(f.events.filter(x=>x==='acquire').length,1);await f.engine.close();
});
test('no-token client does not remember unauthorized status and bearer prefix is preserved',async()=>{
 const f=fixture([{status:401,body:'{}'},{status:200}],{token:null});await assert.rejects(f.engine.sendValidated(request()),/HTTP 401/);assert.equal(f.engine.authorizationInvalidated,false);assert.equal(await f.engine.sendValidated(request()),91n);await f.engine.close();const bearer=fixture([{status:200}],{token:'Bearer fake'});await bearer.engine.sendValidated(request());assert.equal(bearer.requests[0]!.authorization,'Bearer fake');await bearer.engine.close();
});
test('typing success does not decode a Message body and pre-abort never sends',async()=>{
 const f=fixture([{status:204}],{decode:()=>{throw new Error('No model');}});await f.engine.createTyping(1n,new AbortController().signal);assert.equal(f.requests[0]!.path,'channels/1/typing');assert.equal(f.requests[0]!.body,null);assert.equal(f.reads(),0);const abort=new AbortController(),reason=new Error('stop');abort.abort(reason);await assert.rejects(f.engine.createTyping(1n,abort.signal),e=>e===reason);assert.equal(f.requests.length,1);await f.engine.close();
});
test('receipt decoding and invalid identities never become definite provider rejection',async()=>{
 for(const decode of [()=>0n,()=>1n<<64n,()=>{throw new Error('private body');}]){const f=fixture([{status:200}],{decode});await assert.rejects(f.engine.sendValidated(request()),e=>e instanceof Error&&e.message==='Discord message receipt decode failed: response model could not be decoded');assert.equal(f.requests.length,1);assert.ok(f.events.includes('response-release'));await f.engine.close();}
});
test('malformed UTF8 error body remains unconfirmed while 5xx is never retried',async()=>{
 const bad=fixture([{status:400,bytes:new Uint8Array([0xff])}]);await assert.rejects(bad.engine.sendValidated(request()),/unconfirmed/);await bad.engine.close();const f=fixture([{status:503,body:'{"code":1,"message":"unavailable"}'}]);await assert.rejects(f.engine.sendValidated(request()),/HTTP 503/);assert.equal(f.requests.length,1);await f.engine.close();
});
test('route/header validation sends no request and never echoes token data',()=>{
 assert.throws(()=>fixture([],{token:'private-token\r\nheader'}),e=>e instanceof Error&&!e.message.includes('private-token'));const f=fixture([]);for(const path of ['channels/0/messages','channels/1/messages\n','channels/1/messages\r','channels/1/messages\u2028','https://foreign/messages','/channels/1/messages?x','channels/18446744073709551616/messages'])assert.throws(()=>f.engine.sendValidated({...request(),path}));assert.equal(f.requests.length,0);
});
test('close signals actual wire and waits for it to settle; later work is rejected',{timeout:5000},async()=>{
 const entered=deferred(),release=deferred();let signal:AbortSignal|undefined,cleaned=false;const engine=new DiscordResponseEngine({token:'fake',decoder:{decode:()=>1n},rateLimiter:{acquire:async()=>({complete(){},release(){}})},wire:{request:async(_r,_t,s)=>{signal=s;entered.resolve();await release.promise;return {status:200,headers:new Map(),bytes:async()=>new Uint8Array(),release:async()=>{cleaned=true;}};}}});const requestPromise=engine.sendValidated(request());await entered.promise;const reason=new Error('close');let closed=false;const closing=engine.close(reason).then(()=>{closed=true;});await tick();assert.equal(signal?.aborted,true);assert.equal(closed,false);await assert.rejects(engine.sendValidated(request()),e=>e===reason);release.resolve();await requestPromise;await closing;assert.equal(cleaned,true);
});
async function receipt(path:string){return usingInitializedStore(path,db=>db.prepare('SELECT * FROM codex_delivery_receipts').get());}
for(const [status,body,blocked] of [[400,'{}',true],[400,'not-json',false],[503,'{}',false]] as const)test(`receipt custody matches ${status} ${body}: blocked=${blocked}`,async()=>storeFixture(async path=>{
 const f=fixture([{status,body}]);const chunk={domain:'test',logicalKey:'key',chunkIndex:0,content:'message'};await assert.rejects(sendReceiptChunk(path,f.engine,1n,chunk));const row=(await receipt(path))!;assert.equal(row.retryable,0);assert.equal(row.blocked_reason!==null,blocked);await assert.rejects(sendReceiptChunk(path,f.engine,1n,chunk));assert.equal(f.requests.length,1);await f.engine.close();
}));

test('UTF8 BOM is retained and rejected like serde JSON rather than stripped into a definite rejection',async()=>{
 const f=fixture([{status:400,bytes:new Uint8Array([239,187,191,123,125])}]);await assert.rejects(f.engine.sendValidated(request()),/unconfirmed/);await f.engine.close();
});
