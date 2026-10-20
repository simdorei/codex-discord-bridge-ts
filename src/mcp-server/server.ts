import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {parseBridgeInboundMessage} from '../remote-agent/bridge-inbound.ts';
import {BridgeBroker,type BridgeConnection} from './broker.ts';
import {OAuthOwner} from './oauth-owner.ts';
import {OAuthError,type Access} from './oauth-store.ts';
import {authenticateDevice,digest,scopes,type GatewayConfig} from './config.ts';
import {definitions,dispatchTool,requiredScopes} from './tools.ts';
const versions=['2025-11-25','2025-06-18','2025-03-26'];
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const html=(v:string)=>v.replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function send(response:ServerResponse,status:number,value?:unknown,type='application/json'){
 if(response.destroyed||response.writableEnded)return;response.statusCode=status;response.setHeader('Cache-Control','no-store');response.setHeader('Pragma','no-cache');response.setHeader('X-Content-Type-Options','nosniff');if(value===undefined){response.end();return;}response.setHeader('Content-Type',type+'; charset=utf-8');response.end(type==='application/json'?serializeSerdeValue(value):String(value));
}
function redirect(response:ServerResponse,url:string){response.setHeader('Location',url);send(response,303);}
function form(raw:string){const values=new URLSearchParams(raw),result:Record<string,string>={};for(const [k,v]of values){if(Object.hasOwn(result,k))throw new OAuthError('invalid_request');Object.defineProperty(result,k,{value:v,enumerable:true});}return result;}
function oauthError(response:ServerResponse,error:unknown){const code=error instanceof OAuthError?error.code:'server_error';send(response,code==='invalid_client'||code==='approval_denied'?401:code==='temporarily_unavailable'?503:code==='server_error'?500:400,{error:code,error_description:code==='server_error'?'The OAuth server could not complete the request.':'The OAuth request could not be completed.'});}
export async function startGateway(config:GatewayConfig){
 const oauth=new OAuthOwner(config.oauth);try{await oauth.ready();}catch(error){await oauth.close();throw error;}
 const broker=new BridgeBroker(config.requestTimeoutMs),websocket=new WebSocketServer({noServer:true,maxPayload:12000000,perMessageDeflate:false});
 const active=new Set<Promise<void>>(),calls=new Map<string,AbortController>(),shutdown=new AbortController();let closing=false,bodyBytes=0;
 const base=config.oauth.base,allowedHosts=new Set([new URL(base).hostname,'localhost','127.0.0.1','[::1]']);
 const allowed=(request:IncomingMessage)=>{try{const host=new URL('http://'+request.headers.host);return allowedHosts.has(host.hostname)&&!host.username&&!host.password&&host.pathname==='/'&&(!request.headers.origin||request.headers.origin===new URL(base).origin);}catch{return false;}};
 const handle=async(request:IncomingMessage,response:ServerResponse)=>{
  let charged=0;
  const body=async(max:number)=>{const chunks:Buffer[]=[];let size=0;for await(const part of request){const chunk=Buffer.from(part);size+=chunk.length;if(size>max||bodyBytes+chunk.length>48000000)throw new OAuthError('temporarily_unavailable');charged+=chunk.length;bodyBytes+=chunk.length;chunks.push(chunk);}return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size));};
  try{
   if(closing||active.size>=64){send(response,503);return;}if(!allowed(request)){send(response,403);return;}
   const url=new URL(request.url??'/',base),path=url.pathname,method=request.method;
   if(path==='/healthz'&&method==='GET'){send(response,200,{ok:true,service:'simdorei-local-project-mcp',upstream_ready:broker.listDevices().length>0,configured_devices:config.credentials.length,connected_devices:broker.listDevices().length});return;}
   if(path==='/.well-known/oauth-protected-resource/mcp'&&method==='GET'){send(response,200,{resource:config.oauth.resource,authorization_servers:[base],scopes_supported:scopes,bearer_methods_supported:['header']});return;}
   if(path==='/.well-known/oauth-authorization-server'&&method==='GET'){send(response,200,{issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',registration_endpoint:base+'/register',revocation_endpoint:base+'/revoke',scopes_supported:scopes,response_types_supported:['code'],grant_types:['authorization_code','refresh_token'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['client_secret_post'],code_challenge_methods_supported:['S256'],authorization_response_iss_parameter_supported:true});return;}
   if(path==='/register'&&method==='POST'){if(!request.headers['content-type']?.startsWith('application/json')){send(response,415);return;}const input=JSON.parse(await body(65536));if(!record(input))throw new OAuthError('invalid_request');send(response,201,await oauth.call('register',input));return;}
   if(path==='/authorize'&&method==='GET'){const input=form(url.search.slice(1));try{const pending=await oauth.call('authorize',input);redirect(response,pending.approval_url);}catch(error){if(error instanceof OAuthError&&await oauth.call('registered_redirect',input)){const callback=new URL(input.redirect_uri!);callback.searchParams.append('error',error.code);callback.searchParams.append('iss',base);if(input.state!==undefined)callback.searchParams.append('state',input.state);redirect(response,callback.href);}else throw error;}return;}
   if(path==='/oauth/approve'&&(method==='GET'||method==='POST')){
    const input=method==='GET'?form(url.search.slice(1)):form(await body(65536));let denied=false;
    if(method==='POST'){if(!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')){send(response,415);return;}try{redirect(response,await oauth.call<string>('approve',input));return;}catch(error){if(!(error instanceof OAuthError)||error.code!=='approval_denied')throw error;denied=true;}}
    const pending=await oauth.call<string[]|null>('pending',input);response.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self'; frame-ancestors 'none'");
    const page=pending?`<h1>Connect local project</h1><p>${html(pending.join(', '))}</p>${denied?'<p>The owner token did not match.</p>':''}<form method="post" action="/oauth/approve"><input type="hidden" name="request_id" value="${html(input.request_id??'')}"><label>Owner token <input type="password" name="owner_token" required autocomplete="off"></label><button type="submit">Approve</button></form>`:'<h1>This authorization request expired.</h1>';
    send(response,pending?(denied?401:200):400,'<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect local project</title><main>'+page+'</main></html>','text/html');return;
   }
   if((path==='/token'||path==='/revoke')&&method==='POST'){if(!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')){send(response,415);return;}const result=await oauth.call(path==='/token'?'token':'revoke',form(await body(65536)));send(response,200,path==='/revoke'?undefined:result);return;}
   if(path!=='/mcp'&&path!=='/mcp/'){send(response,404);return;}
   const bearer=/^Bearer ([^\s]+)$/iu.exec(request.headers.authorization??''),access=bearer?await oauth.call<Access|null>('access',{token:bearer[1]}):null;
   if(!access||!access.subject||!access.scopes.includes('files:read')){response.setHeader('WWW-Authenticate',`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="files:read"`);send(response,401);return;}
   if(method!=='POST'){response.setHeader('Allow','POST');send(response,405);return;}
   if(request.headers['mcp-protocol-version']!==undefined&&!versions.includes(String(request.headers['mcp-protocol-version']))){send(response,400);return;}
   const accept=request.headers.accept??'';if(!accept.includes('application/json')||!accept.includes('text/event-stream')){send(response,406);return;}if(!request.headers['content-type']?.startsWith('application/json')){send(response,415);return;}
   let rpc:unknown;try{rpc=parseSerdeValue(await body(12000000));}catch(error){if(error instanceof OAuthError)throw error;send(response,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return;}
   if(!record(rpc)||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string'||rpc.id!==undefined&&typeof rpc.id!=='string'&&typeof rpc.id!=='bigint'){send(response,400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}});return;}
   const params=rpc.params===undefined?{}:rpc.params;if(!record(params)){send(response,400,{jsonrpc:'2.0',id:rpc.id??null,error:{code:-32602,message:'Invalid parameters'}});return;}
   const principal=digest(Buffer.byteLength(access.subject)+':'+access.subject+access.client_id),meta=record(params._meta)?params._meta:{},session=meta['openai/session'];
   const callKey=(requestId:unknown)=>serializeSerdeValue([principal,session,requestId]);
   if(rpc.id===undefined){if(rpc.method==='notifications/cancelled'&&typeof session==='string')calls.get(callKey(params.requestId))?.abort();send(response,202);return;}
   const reply=(result:unknown)=>send(response,200,{jsonrpc:'2.0',id:rpc.id,result});
    if(rpc.method==='initialize'){reply({protocolVersion:versions.includes(String(params.protocolVersion))?params.protocolVersion:versions[0],capabilities:{tools:{}},serverInfo:{name:'simdorei-local-project',version:'0.1.0-alpha.6'},instructions:'Operate the selected local project through its connected agent.'});return;}
   if(rpc.method==='ping'){reply({});return;}if(rpc.method==='tools/list'){reply({tools:definitions});return;}
   if(rpc.method!=='tools/call'){send(response,200,{jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'Method not found'}});return;}
   const visible=(message:string)=>reply({isError:true,content:[{type:'text',text:message}]});
   const name=params.name,required=typeof name==='string'?requiredScopes(name):undefined;if(!required){send(response,200,{jsonrpc:'2.0',id:rpc.id,error:{code:-32602,message:'Unknown tool'}});return;}
   const missing=required.find(scope=>!access.scopes.includes(scope));if(missing){visible('OAuth scope '+missing+' is required.');return;}
   if(typeof session!=='string'||!session||Buffer.byteLength(session)>4096){visible('ChatGPT did not provide conversation session metadata.');return;}
   const args=params.arguments??{};if(!record(args)){visible('Invalid tool arguments');return;}
   const key=callKey(rpc.id);if(calls.has(key)){visible('This request ID is already active; no replay was attempted.');return;}
   const controller=new AbortController(),cancel=()=>controller.abort();shutdown.signal.addEventListener('abort',cancel,{once:true});calls.set(key,controller);
   // A dropped HTTP connection does not cancel or replay an admitted mutation.
   // Only an authenticated matching cancellation notification or shutdown does.
   try{reply(await dispatchTool(broker,config.oauth.resource,session,principal,name as string,args,controller.signal));}catch(error){visible(error instanceof Error?error.message.slice(0,1000):'Local project request failed');}finally{calls.delete(key);shutdown.signal.removeEventListener('abort',cancel);}
  }catch(error){oauthError(response,error);}finally{bodyBytes-=charged;}
 };
 const server=createServer({maxHeaderSize:16384,requestTimeout:30000,headersTimeout:10000},(request,response)=>{const task=handle(request,response);active.add(task);void task.finally(()=>active.delete(task)).catch(()=>{});});server.maxConnections=128;
 server.on('upgrade',(request,socket,head)=>{
  const device=authenticateDevice(config,request.headers.authorization??'');if(closing||!allowed(request)||request.url!=='/bridge'||!device){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;}
  websocket.handleUpgrade(request,socket,head,ws=>{
   let connection:BridgeConnection|undefined;const timer=setTimeout(()=>ws.close(1002,'hello required'),10000),sendRaw=(raw:string)=>{if(ws.readyState!==WebSocket.OPEN||ws.bufferedAmount+Buffer.byteLength(raw)>48000000)throw Error('Bridge output capacity exceeded');ws.send(raw,error=>{if(error)ws.terminate();});};
   ws.on('message',(bytes,binary)=>{try{if(binary){ws.close(1003,'text required');return;}const message=parseBridgeInboundMessage(bytes.toString(),12000000);
    if(!connection){if(message.type!=='hello'||message.device_id!==device){ws.close(1008,'device mismatch');return;}clearTimeout(timer);connection=broker.attach(device,sendRaw,()=>ws.close(1012,'bridge replaced'));sendRaw('{"type":"hello_ack","protocol_version":10}');return;}
    if(message.type==='hello'){ws.close(1002,'duplicate hello');return;}
    if(message.type==='project_upsert'){const p={scope:message.project_scope,binding:message.binding_id,thread:message.thread_id,name:message.project_name,expires:Number(message.expires_at.seconds)*1000+Number(message.expires_at.nanosecond/1000000n)};broker.upsert(connection,p);sendRaw(JSON.stringify({type:'project_ack',project_scope:p.scope,binding_id:p.binding}));void broker.resume(connection,p).catch(()=>{});}
    else broker.complete(connection,message);
   }catch{ws.close(1008,'invalid bridge message');}});
   ws.on('error',()=>ws.terminate());ws.once('close',()=>{clearTimeout(timer);if(connection)broker.detach(connection);});
  });
 });
 try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,()=>{server.removeListener('error',reject);resolve();});});}catch(error){websocket.close();await oauth.close();throw error;}
 let closeTask:Promise<void>|undefined;
 return{server,broker,address:server.address(),close:()=>closeTask??=(async()=>{closing=true;shutdown.abort();broker.close();for(const ws of websocket.clients)ws.terminate();const httpClosed=new Promise<void>(resolve=>server.close(()=>resolve()));server.closeAllConnections();await Promise.allSettled([...active]);await httpClosed;await new Promise<void>(resolve=>websocket.close(()=>resolve()));await oauth.close();})()};
}
