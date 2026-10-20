import {randomUUID} from 'node:crypto';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {parseGatewayCommand} from '../remote-agent/gateway-command.ts';
import type {BridgeResult} from '../remote-agent/bridge-inbound.ts';
export interface BridgeConnection{readonly device:string;readonly id:string;send:(raw:string)=>void;close:()=>void;}
export interface ProjectRegistration{scope:string;binding:string;thread:string;name:string;expires:number;}
interface Project extends ProjectRegistration{device:string;}
interface Route{session:string;subject:string;device:string;thread:string;computer:string;generation:bigint;expires:number;directory:string|null;}
interface Dormant{route:Route;scope:string;binding:string;until:number;}
interface Pending{connection:BridgeConnection;resolve:(result:BridgeResult)=>void;reject:(error:unknown)=>void;cleanup:()=>void;}
const id=()=>randomUUID().replaceAll('-','');
const key=(device:string,thread:string)=>JSON.stringify([device,thread]);
/** A request owns one connection generation. Disconnect/timeout never replays it.
 * Selection updates are synchronous; agent waits for unrelated routes overlap. */
export class BridgeBroker{
 readonly #devices=new Map<string,BridgeConnection>();readonly #projects=new Map<string,Project>();readonly #routes=new Map<string,Route>();readonly #dormant=new Map<string,Dormant>();readonly #generations=new Map<string,bigint>();readonly #pending=new Map<string,Pending>();#pendingBytes=0;
 constructor(readonly timeoutMs:number){}
 #prune(){const now=Date.now();for(const [s,p]of this.#projects)if(p.expires<=now)this.#projects.delete(s);for(const [s,r]of this.#routes)if(r.expires<=now)this.#routes.delete(s);for(const [s,d]of this.#dormant)if(d.until<=now||d.route.expires<=now)this.#dormant.delete(s);}
 attach(device:string,send:BridgeConnection['send'],close:()=>void):BridgeConnection{const old=this.#devices.get(device);if(old){this.detach(old);old.close();}const connection={device,id:id(),send,close};this.#devices.set(device,connection);return connection;}
 detach(connection:BridgeConnection){if(this.#devices.get(connection.device)!==connection)return;const now=Date.now();this.#devices.delete(connection.device);
  for(const [session,route]of this.#routes)if(route.device===connection.device){const project=[...this.#projects.values()].find(p=>p.device===route.device&&p.thread===route.thread);if(route.directory===null&&project&&route.expires>now)this.#dormant.set(key(route.device,route.thread),{route,scope:project.scope,binding:project.binding,until:Math.min(route.expires,now+120000)});this.#routes.delete(session);}
  for(const [scope,project]of this.#projects)if(project.device===connection.device)this.#projects.delete(scope);
  for(const pending of [...this.#pending.values()])if(pending.connection===connection){pending.cleanup();pending.reject(Error('Bridge disconnected; request was not replayed'));}
 }
 close(){for(const connection of [...this.#devices.values()]){this.detach(connection);connection.close();}this.#dormant.clear();}
 listDevices(){return [...this.#devices.keys()].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())).map(device_id=>({device_id,online:true}));}
 upsert(connection:BridgeConnection,p:ProjectRegistration){
  this.#prune();if(this.#devices.get(connection.device)!==connection||p.expires<=Date.now())throw Error('Project unavailable');
  const existing=this.#projects.get(p.scope);if(existing&&existing.device!==connection.device||[...this.#dormant.values()].some(d=>d.scope===p.scope&&d.route.device!==connection.device))throw Error('Project belongs to another device');
  if(!existing&&this.#projects.size>=4096)throw Error('Project capacity exceeded');const project={...p,device:connection.device};
  if(existing&&existing.binding===p.binding&&existing.thread===p.thread&&existing.name===p.name){this.#projects.set(p.scope,project);for(const route of this.#routes.values())if(route.device===connection.device&&route.thread===p.thread)route.expires=Math.max(route.expires,p.expires);const dormant=this.#dormant.get(key(connection.device,p.thread));if(dormant)dormant.route.expires=Math.max(dormant.route.expires,p.expires);return;}
  for(const [scope,old]of this.#projects)if(old.device===connection.device&&old.thread===p.thread&&scope!==p.scope)this.#projects.delete(scope);
  for(const [session,route]of this.#routes)if(route.device===connection.device&&route.thread===p.thread)this.#routes.delete(session);
  const dormantKey=key(connection.device,p.thread),dormant=this.#dormant.get(dormantKey);if(dormant&&(dormant.scope!==p.scope||dormant.binding!==p.binding))this.#dormant.delete(dormantKey);this.#projects.set(p.scope,project);
 }
 async resume(connection:BridgeConnection,p:ProjectRegistration){this.#prune();const k=key(connection.device,p.thread),d=this.#dormant.get(k),current=this.#projects.get(p.scope);if(this.#devices.get(connection.device)!==connection||!d||current?.binding!==p.binding||d.scope!==p.scope||d.binding!==p.binding)return false;this.#dormant.delete(k);
  // A later explicit selection always wins over a reconnect observation.
  if(this.#routes.has(d.route.session))return false;const route=this.#prepare(d.route.session,d.route.subject,connection.device,p.thread,p.expires,null);try{await this.#activate(route);return true;}catch{return false;}
 }
 complete(connection:BridgeConnection,result:BridgeResult){const pending=this.#pending.get(result.request_id);if(this.#devices.get(connection.device)!==connection||pending?.connection!==connection)return;pending.cleanup();pending.resolve(result);}
 #prepare(session:string,subject:string,device:string,thread:string,expires:number,directory:string|null):Route{
  this.#prune();const existing=this.#routes.get(session);if(existing&&existing.subject!==subject)throw Error('OAuth principal does not match this conversation');if(!this.#devices.has(device))throw Error('Bridge unavailable');if(!existing&&this.#routes.size>=4096)throw Error('Session capacity exceeded');
  const k=key(device,thread),generation=(this.#generations.get(k)??0n)+1n;if(generation>18446744073709551615n)throw Error('Session generation exhausted');this.#generations.set(k,generation);const route={session,subject,device,thread,computer:id(),generation,expires,directory};this.#routes.set(session,route);return route;
 }
 #route(session:string,subject:string){this.#prune();const route=this.#routes.get(session);if(!route)throw Error('Select a project or device first');if(route.subject!==subject)throw Error('OAuth principal does not match this conversation');if(!this.#devices.has(route.device))throw Error('Bridge unavailable');return route;}
 async #activate(route:Route,signal?:AbortSignal){try{const result=await this.#dispatch(route,{type:route.directory===null?'project_session':'device_session',computer_session_generation:route.generation,...(route.directory===null?{}:{working_directory:route.directory,expires_at:new Date(route.expires).toISOString()})},signal);if(result.type!=='project_session_result')throw Error(result.type==='operation_error'?result.message:'Unexpected bridge result');if(this.#routes.get(route.session)!==route)throw Error('Selection was superseded');}catch(error){if(this.#routes.get(route.session)===route)this.#routes.delete(route.session);throw error;}}
 async selectProject(session:string,subject:string,scope:string,signal?:AbortSignal){this.#prune();const project=this.#projects.get(scope);if(!project)throw Error('Project unavailable');const route=this.#prepare(session,subject,project.device,project.thread,project.expires,null);await this.#activate(route,signal);return{project_name:project.name,thread_id:route.thread,expires_at:new Date(route.expires).toISOString()};}
 async selectDevice(session:string,subject:string,device:string,directory:string,signal?:AbortSignal){if(!directory||Buffer.byteLength(directory)>1000)throw Error('Invalid working directory');const route=this.#prepare(session,subject,device,'codex-device-control',Date.now()+1800000,directory);await this.#activate(route,signal);return this.deviceInfo(session,subject);}
 async setDirectory(session:string,subject:string,directory:string,signal?:AbortSignal){const route=this.#route(session,subject);if(route.directory===null)throw Error('Select a device first');return this.selectDevice(session,subject,route.device,directory,signal);}
 deviceInfo(session:string,subject:string){const route=this.#route(session,subject);if(route.directory===null)throw Error('Select a device first');return{device_id:route.device,working_directory:route.directory,expires_at:new Date(route.expires).toISOString()};}
 async command(session:string,subject:string,fields:Record<string,unknown>,expected:BridgeResult['type'],signal?:AbortSignal,seconds=60):Promise<unknown>{const result=await this.#dispatch(this.#route(session,subject),fields,signal,seconds);if(result.type==='operation_error')throw Error(result.message);if(result.type!==expected||!('output'in result))throw Error('Unexpected bridge result');return result.output;}
 #dispatch(route:Route,fields:Record<string,unknown>,signal?:AbortSignal,seconds=60):Promise<BridgeResult>{
  signal?.throwIfAborted();if(this.#routes.get(route.session)!==route)throw Error('Selection was superseded');const connection=this.#devices.get(route.device);if(!connection)throw Error('Bridge unavailable');const request=id(),raw=serializeSerdeValue({type:'project_info',...fields,request_id:request,thread_id:route.thread,computer_session_id:route.computer,deadline_at:new Date(Date.now()+seconds*1000).toISOString()});parseGatewayCommand(raw,12000000);
  const bytes=Buffer.byteLength(raw);if(this.#pending.size>=256||[...this.#pending.values()].filter(p=>p.connection===connection).length>=32||this.#pendingBytes+bytes>48000000)throw Error('Bridge request capacity exceeded');
  return new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(this.#pending.delete(request))this.#pendingBytes-=bytes;},cancel=()=>{cleanup();reject(Error('Request cancelled; no replay was attempted'));},timer=setTimeout(()=>{cleanup();reject(Error('Bridge response timed out; outcome may be unknown; no automatic replay'));},this.timeoutMs);
   this.#pending.set(request,{connection,resolve,reject,cleanup});this.#pendingBytes+=bytes;signal?.addEventListener('abort',cancel,{once:true});try{connection.send(raw);}catch(error){cleanup();reject(error);}
  });
 }
}
