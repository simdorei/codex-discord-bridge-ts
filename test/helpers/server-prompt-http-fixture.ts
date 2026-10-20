import assert from 'node:assert/strict';
import {createServer,type ServerResponse} from 'node:http';
import {DiscordChannelClient} from '../../src/discord/channel-client.ts';
export interface PromptHttpRequest {readonly method:string;readonly path:string;readonly body:string}
export function promptHttpMessage(id='901',content='!approval') {return {attachments:[],author:{id:'2',username:'fixture',discriminator:'0',bot:false},channel_id:'1',content,embeds:[],id,type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false};}
export async function promptHttpFixture(run:(client:DiscordChannelClient,seen:PromptHttpRequest[])=>Promise<void>,reply?:(request:PromptHttpRequest,count:number,response:ServerResponse)=>void|Promise<void>):Promise<void> {
 const seen:PromptHttpRequest[]=[],tasks:Promise<void>[]=[],errors:unknown[]=[];
 const server=createServer((request,response)=>{let body='';request.on('data',chunk=>body+=String(chunk));request.on('end',()=>{
  const item={method:request.method!,path:request.url!,body};seen.push(item);const count=seen.length;
  tasks.push(Promise.resolve().then(async()=>{await reply?.(item,count,response);if(!response.writableEnded){if(item.method==='PATCH'){response.statusCode=204;response.end();}else response.end(JSON.stringify(promptHttpMessage(String(900+count),'')));}}).catch(error=>{errors.push(error);response.statusCode=500;response.end('{}');}));
 });});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
 const client=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${address.port}/api/v10/`,report:()=>{}});
 try{await run(client,seen);await Promise.all(tasks);assert.deepEqual(errors,[]);}finally{await client.close();await Promise.all(tasks);server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));assert.equal(client.activeRequests,0);assert.equal(client.ownedSockets,0);}
}
