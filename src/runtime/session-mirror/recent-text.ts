import {createHash} from 'node:crypto';
import {rustTrim} from '../../app-server/value.ts';
import {requireDiscordText} from '../../discord/text.ts';

export function normalizedMirrorTextDigest(text:string):string{
 requireDiscordText(text);return createHash('sha256').update(rustTrim(text),'utf8').update('\0').digest('hex');
}
/** Optional process-local duplicate suppression, never delivery evidence. Limits
 * supplement Rust's TTL-only cache: saturation declines to remember a new item,
 * preserving durable receipt checks rather than dropping accepted work. */
export class RecentMirrorTextCache {
 readonly #ttl:bigint;readonly #maximum:number;
 readonly #seen=new Map<string,Map<string,bigint>>();#size=0;
 constructor(ttlNanoseconds:bigint,maxEntries:number){
  if(typeof ttlNanoseconds!=='bigint'||ttlNanoseconds<0n)throw new RangeError('Expected nonnegative monotonic TTL');
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>16384)throw new RangeError('Expected cache entry bound from 1 through 16384');
  this.#ttl=ttlNanoseconds;this.#maximum=maxEntries;
 }
 get size():number{return this.#size;}
 pruneExpired(now=process.hrtime.bigint()):void{
  this.#clock(now);
  for(const[scope,entries]of this.#seen){for(const[digest,at]of entries){const elapsed=now>=at?now-at:0n;if(elapsed>this.#ttl){entries.delete(digest);this.#size--;}}if(entries.size===0)this.#seen.delete(scope);}
 }
 isRecent(scope:string,text:string,now=process.hrtime.bigint()):boolean{
  this.pruneExpired(now);if(!this.#bounded(scope,text))return false;
  return this.#seen.get(scope)?.has(normalizedMirrorTextDigest(text))??false;
 }
 remember(scope:string,text:string,now=process.hrtime.bigint()):boolean{
  this.pruneExpired(now);if(!this.#bounded(scope,text))return false;
  const digest=normalizedMirrorTextDigest(text),entries=this.#seen.get(scope);
  if(entries?.has(digest)){entries.set(digest,now);return true;}
  if(this.#size===this.#maximum)return false;
  const target=entries??new Map<string,bigint>();target.set(digest,now);if(entries===undefined)this.#seen.set(scope,target);this.#size++;return true;
 }
 #clock(now:bigint):void{if(typeof now!=='bigint'||now<0n)throw new RangeError('Expected nonnegative monotonic clock');}
 #bounded(scope:string,text:string):boolean{
  requireDiscordText(scope);requireDiscordText(text);
  return Buffer.byteLength(scope,'utf8')<=4096&&Buffer.byteLength(text,'utf8')<=262144;
 }
}
