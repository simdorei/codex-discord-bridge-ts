import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer,type RequestListener} from 'node:http';
import {dirname,join} from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {storeFixture} from '../helpers/store-fixture.ts';
import {decodeGatewayMessage} from '../../src/discord/gateway/decoded-message.ts';
import {AttachmentHttpClient} from '../../src/runtime/attachment-client.ts';
import {enrichMessageAttachments as enrich,AttachmentError} from '../../src/runtime/attachments.ts';
const config={attachmentsEnabled:true,attachmentMaxBytes:100n,attachmentTextInlineMaxBytes:100n};
function message(urls:string[]){return decodeGatewayMessage(JSON.stringify({attachments:urls.map((url,i)=>({id:String(i+10),filename:`a${i}.txt`,size:0,url,proxy_url:url,content_type:'text/plain'})),author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content:'ask',edited_timestamp:null,embeds:[],id:'3',mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-02-02T02:02:02.020000+00:00',tts:false,type:0}));}
async function fixture(handler:RequestListener,run:(base:string,client:AttachmentHttpClient)=>Promise<void>){
 const server=createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const client=new AttachmentHttpClient();
 try{await run(`http://127.0.0.1:${(server.address() as {port:number}).port}`,client);}finally{await client.close();server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));assert.equal(client.activeRequests,0);assert.equal(client.ownedSockets,0);}
}
test('native streaming envelope follows relative redirect and saves two required inputs sequentially',()=>storeFixture(path=>{
 const seen:string[]=[];return fixture((req,res)=>{assert.equal(req.headers.authorization,undefined);seen.push(req.url!);if(req.url==='/redirect'){res.writeHead(302,{location:'/file'});res.end();}else res.end('한😀');},async(base,client)=>{
 const result=await enrich(message([base+'/redirect',base+'/file']),' ask ',config,dirname(path),client,true,()=>assert.fail());assert.deepEqual(seen,['/redirect','/file','/file']);assert.match(result,/sha256: [a-f0-9]{64}/);assert.match(result,/Attachment text previews:/);assert.equal((await readFile(join(dirname(path),'1','3','01-a0.txt'))).toString(),'한😀');assert.equal(client.activeRequests,0);
 });
}));
test('ordinary failure renders sanitized failure and continues; required failure prevents later download',()=>storeFixture(path=>{
 const seen:string[]=[];return fixture((req,res)=>{seen.push(req.url!);if(req.url?.startsWith('/bad'))res.writeHead(403);res.end('ok');},async(base,client)=>{
 const reports:string[]=[];const result=await enrich(message([base+'/bad?token=DO_NOT_EXPOSE',base+'/ok']),'ask',config,dirname(path),client,false,e=>{reports.push(e.error);});assert.match(result,/1. a0.txt failed to save: attachment HTTP status 403/);assert.equal(reports.length,1);assert.doesNotMatch(result,/DO_NOT_EXPOSE/);assert.deepEqual(seen,['/bad?token=DO_NOT_EXPOSE','/ok']);seen.length=0;
 await assert.rejects(enrich(message([base+'/bad',base+'/ok']),'ask',config,dirname(path),client,true,()=>assert.fail()),e=>e instanceof AttachmentError&&e.kind==='Required');assert.deepEqual(seen,['/bad']);
 });
}));
test('disabled ordinary input returns unchanged; required input and forged message fail before transport',()=>storeFixture(async path=>{
 let calls=0;const transport={async get(){calls++;throw Error('must not request');}},m=message(['https://example.invalid/not-requested']);assert.equal(await enrich(m,' ask ',{...config,attachmentsEnabled:false},dirname(path),transport,false,()=>{}),' ask ');
 await assert.rejects(enrich(m,'ask',{...config,attachmentsEnabled:false},dirname(path),transport,true,()=>{}),/attachments are disabled/);await assert.rejects(enrich({...m},'ask',config,dirname(path),transport,false,()=>{}),TypeError);assert.equal(calls,0);await assert.rejects(stat(join(dirname(path),'1')),{code:'ENOENT'});
}));
test('native response oversize cancellation joins hanging body without global client shutdown',()=>storeFixture(path=>fixture((_req,res)=>{res.writeHead(200,{'content-length':'999'});res.flushHeaders();},async(base,client)=>{
 const result=await enrich(message([base]),'ask',config,dirname(path),client,false,()=>assert.fail());assert.match(result,/response exceeds 100 bytes/);assert.equal(client.activeRequests,0);await assert.rejects(stat(join(dirname(path),'1','3','01-a0.txt')),{code:'ENOENT'});
})));
test('native client close cancels pending body and headers and rejects reuse',()=>fixture((req,res)=>{if(req.url==='/body'){res.writeHead(200);res.write('ab');}},async(base,client)=>{
 const response=await client.get(base+'/body'),iterator=response.chunks[Symbol.asyncIterator]();assert.equal(Buffer.from((await iterator.next()).value!).toString(),'ab');const failed=assert.rejects(iterator.next(),/body failed/);await client.close();await failed;await response.release();assert.equal(client.activeRequests,0);await assert.rejects(client.get(base),/client closed/);
}));
test('close before headers joins owned pending request',()=>fixture(()=>{},async(base,client)=>{
 const pending=client.get(base),failed=assert.rejects(pending,/request/);await client.close();await failed;assert.equal(client.activeRequests,0);
}));
test('redirect ceiling accepts ten hops and rejects endless redirects without URL disclosure',()=>fixture((req,res)=>{const n=Number(req.url?.slice(1));if(Number.isFinite(n)&&n===10)res.end('done');else{res.writeHead(302,{location:Number.isFinite(n)?`/${n+1}`:'/loop'});res.end();}},async(base,client)=>{
 const response=await client.get(base+'/0');let text='';for await(const c of response.chunks)text+=Buffer.from(c).toString();await response.release();assert.equal(text,'done');await assert.rejects(client.get(base+'/loop'),/redirect limit/);assert.equal(client.activeRequests,0);
}));
test('credential URLs and unsupported protocols are rejected without network',async()=>{
 const client=new AttachmentHttpClient();try{for(const url of ['file:///tmp/x','https://u:p@example.invalid/','broken'])await assert.rejects(client.get(url),/attachment URL/);assert.equal(client.activeRequests,0);}finally{await client.close();}
});
test('empty attachments preserve bytes without creating a directory or touching transport',()=>storeFixture(async path=>{
 assert.equal(await enrich(message([]),' ask ',config,dirname(path),{async get(){assert.fail();}},true,()=>{}),' ask ');await assert.rejects(stat(join(dirname(path),'1')),{code:'ENOENT'});
}));
