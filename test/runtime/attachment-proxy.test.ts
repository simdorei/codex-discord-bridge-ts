import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {AttachmentHttpClient} from '../../src/runtime/attachment-client.ts';
const listen=(server:Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+(server.address() as {port:number}).port)));
async function body(client:AttachmentHttpClient,url:string){const response=await client.get(url);try{let text='';for await(const chunk of response.chunks)text+=Buffer.from(chunk).toString();return text;}finally{await response.release();}}
test('attachment transport captures HTTP proxy configuration and honors NO_PROXY without leaking sockets',async()=>{
 let proxied=0,direct=0;const proxy=createServer((request,response)=>{proxied++;assert.equal(request.url,'http://example.invalid/fixture');response.end('proxy');}),target=createServer((_request,response)=>{direct++;response.end('direct');});
 const proxyUrl=await listen(proxy),targetUrl=await listen(target),env={HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,NO_PROXY:'127.0.0.1'};
 const client=new AttachmentHttpClient(env);env.HTTP_PROXY='http://127.0.0.1:1';
 try{assert.equal(await body(client,'http://example.invalid/fixture'),'proxy');assert.equal(await body(client,targetUrl),'direct');assert.equal(proxied,1);assert.equal(direct,1);}
 finally{await client.close();proxy.closeAllConnections();target.closeAllConnections();await Promise.all([new Promise<void>(r=>proxy.close(()=>r())),new Promise<void>(r=>target.close(()=>r()))]);}
 assert.equal(client.activeRequests,0);assert.equal(client.ownedSockets,0);
});
