import {Worker} from 'node:worker_threads';
import type {OAuthConfig} from './config.ts';
import {OAuthError} from './oauth-store.ts';
export class OAuthOwner{
 readonly #worker:Worker;readonly #pending=new Map<number,{resolve:(value:any)=>void;reject:(error:unknown)=>void}>();#next=1;#closed=false;readonly #exited:Promise<void>;readonly #ready:Promise<void>;
 constructor(config:OAuthConfig){
  this.#worker=new Worker(new URL(import.meta.url.endsWith('.ts')?'./oauth-worker.ts':'./oauth-worker.js',import.meta.url),{workerData:config,resourceLimits:{maxOldGenerationSizeMb:128}});
  this.#ready=new Promise((resolve,reject)=>{this.#worker.once('message',message=>message?.ready===true?resolve():reject(Error('OAuth startup failed')));this.#worker.once('error',reject);this.#worker.once('exit',()=>reject(Error('OAuth worker exited before ready')));});void this.#ready.catch(()=>{});
  this.#worker.on('message',m=>{const pending=this.#pending.get(m?.id);if(!pending)return;this.#pending.delete(m.id);if(m.ok)pending.resolve(m.value);else pending.reject(new OAuthError(m.code));});
  this.#exited=new Promise(resolve=>{this.#worker.once('exit',()=>{this.#closed=true;for(const value of this.#pending.values())value.reject(Error('OAuth operation outcome unavailable; no automatic retry'));this.#pending.clear();resolve();});});
  this.#worker.on('error',()=>{this.#closed=true;});
 }
 async ready(){await this.#ready;}
 async call<T=any>(operation:string,input:Record<string,unknown>={}):Promise<T>{await this.#ready;if(this.#closed||this.#pending.size>=128)throw new OAuthError('temporarily_unavailable');const id=this.#next++;return new Promise((resolve,reject)=>{this.#pending.set(id,{resolve,reject});try{this.#worker.postMessage({id,operation,input});}catch(error){this.#pending.delete(id);reject(error);}});}
 async close(){if(!this.#closed){this.#closed=true;this.#worker.postMessage({operation:'close'});}await this.#exited;}
}
