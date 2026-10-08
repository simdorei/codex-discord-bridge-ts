import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {parseRateF32,parseChannelRateHeaders as parse,DiscordChannelRateLimiter,UnsupportedRateResetError} from '../../src/discord/rate-header-adapter.ts';
import {DiscordResponseEngine} from '../../src/discord/response-engine.ts';
import {idempotentMessageRequest} from '../../src/discord/idempotent-message.ts';
import type {RateClock} from '../../src/discord/channel-rate-state.ts';
const raw=(values:Record<string,string>)=>new Map(Object.entries(values).map(([k,v])=>[k,Buffer.from(v)]));
const user=(changes:Record<string,string>={})=>raw({'x-ratelimit-scope':'user','x-ratelimit-bucket':'b','x-ratelimit-limit':'5','x-ratelimit-remaining':'4','x-ratelimit-reset-after':'0.1',...changes});
class Clock implements RateClock{value=0;next=0;timers=new Map<number,{at:number;run:()=>void}>();now(){return this.value;}schedule(at:number,run:()=>void){const id=++this.next;this.timers.set(id,{at,run});return()=>{this.timers.delete(id);};}advance(ms:number){this.value+=ms;for(let i=0;i<100;i++){const entry=[...this.timers].find(([,t])=>t.at<=this.value);if(!entry)return;this.timers.delete(entry[0]);entry[1].run();}throw new Error('spin');}}
test('direct f32 rounding distinguishes exact midpoint from decimal just above it',()=>{
 const midpoint='1.000000059604644775390625';assert.equal(parseRateF32(midpoint),1);assert.equal(Math.fround(Number(midpoint+'00001')),1);assert.equal(parseRateF32(midpoint+'00001'),1.0000001192092896);assert.equal(parseRateF32('-'+midpoint+'00001'),-1.0000001192092896);
});
test('subnormal midpoint ties to zero but its exact decimal successor rounds up',()=>{
 const digits=(5n**150n).toString().padStart(150,'0'),mid='0.'+digits;assert.equal(parseRateF32(mid),0);assert.equal(parseRateF32(mid+'1'),2**-149);assert.equal(Object.is(parseRateF32('-0'),-0),true);
});
test('normal decimal grammar and overflow preserve binary32 representation',()=>{
 for(const value of ['0.1','+1.5','1e-3','.5','1.','65535','3.4028234663852886e38'])assert.equal(parseRateF32(value),Math.fround(Number(value)));assert.equal(parseRateF32('1e99'),Infinity);assert.equal(parseRateF32('1e-99'),0);for(const invalid of [' 1','1\n','NaN\n','0x10','1_0'])assert.throws(()=>parseRateF32(invalid),SyntaxError);
});
test('scope is byte-exact, global/absent/unknown scopes do not invent local bucket limits',()=>{
 for(const values of [{},{'x-ratelimit-scope':'global'},{'x-ratelimit-scope':'User'},{'x-ratelimit-scope':'other'}])assert.equal(parse(raw(values),5),null);
});
test('user headers preserve u16 limits and exact bucket bytes with monotonic f32 delay',()=>{
 const headers=user({'x-ratelimit-limit':'+0005'}),bucket=new Uint8Array([0,255]);headers.set('x-ratelimit-bucket',Buffer.from(bucket));const result=parse(headers,10)!;assert.deepEqual(result.bucket,bucket);assert.equal(result.limit,5);assert.equal(result.remaining,4);assert.equal(result.resetAtMs,10+Math.fround(0.1)*1000);headers.get('x-ratelimit-bucket')![0]=3;assert.equal(result.bucket[0],0);
});
test('shared retry header is u16 seconds with zero remaining and limit',()=>{
 const v=parse(raw({'x-ratelimit-scope':'shared','x-ratelimit-bucket':'b','retry-after':'+0002'}),3)!;assert.deepEqual([v.limit,v.remaining,v.resetAtMs],[0,0,2003]);for(const value of ['1.5','65536','-1',' 1'])assert.throws(()=>parse(raw({'x-ratelimit-scope':'shared','x-ratelimit-bucket':'b','retry-after':value}),0),SyntaxError);
});
test('ordinary missing/malformed headers are distinguishable from unsupported source duration failures',()=>{
 const missing=user();missing.delete('x-ratelimit-bucket');assert.throws(()=>parse(missing,0),SyntaxError);for(const value of ['NaN','inf','-1','18446744073709551616'])assert.throws(()=>parse(user({'x-ratelimit-reset-after':value}),0),UnsupportedRateResetError);assert.throws(()=>parse(user({'x-ratelimit-limit':'65536'}),0),SyntaxError);
});
test('malformed ordinary header warning completes None and releases the next queued request',async()=>{
 const clock=new Clock(),errors:unknown[]=[],rate=new DiscordChannelRateLimiter({clock,report:e=>{errors.push(e);}}),signal=new AbortController().signal,a=await rate.acquire('POST','channels/1/messages',signal),waiting=rate.acquire('POST','channels/1/messages',signal);a.complete(200,user({'x-ratelimit-limit':'bad'}));a.release();const b=await waiting;b.complete(200,new Map());b.release();assert.equal(errors.length,1);await rate.close();assert.equal(clock.timers.size,0);
});
test('actual response engine obeys shared 429 reset before repeating exact message body',{timeout:5000},async()=>{
 const clock=new Clock(),rate=new DiscordChannelRateLimiter({clock,report:()=>{throw new Error('No header warning');}}),bodies:string[]=[];let count=0;const engine=new DiscordResponseEngine({token:'fake',rateLimiter:rate,decoder:{decode:()=>1n},wire:{request:async req=>{count++;bodies.push(req.body!);return {status:count===1?429:200,headers:count===1?raw({'x-ratelimit-scope':'shared','x-ratelimit-bucket':'b','retry-after':'1'}):new Map(),bytes:async()=>new Uint8Array(),release:async()=>{}};}}});const work=engine.sendValidated(idempotentMessageRequest(1n,'content','test','key',0));await tick();await tick();assert.equal(count,1);clock.advance(999);await tick();assert.equal(count,1);clock.advance(1);assert.equal(await work,1n);assert.equal(count,2);assert.equal(bodies[0],bodies[1]);await engine.close();await rate.close();
});
test('unsupported reset never becomes an unrestricted 429 retry',async()=>{
 const clock=new Clock(),errors:unknown[]=[],rate=new DiscordChannelRateLimiter({clock,report:e=>{errors.push(e);}});let count=0;const engine=new DiscordResponseEngine({token:'fake',rateLimiter:rate,decoder:{decode:()=>1n},wire:{request:async()=>{count++;return {status:429,headers:user({'x-ratelimit-reset-after':'NaN'}),bytes:async()=>new Uint8Array(),release:async()=>{}};}}});await assert.rejects(engine.sendValidated(idempotentMessageRequest(1n,'content','test','key',0)),/unconfirmed/);assert.equal(count,1);assert.equal(errors.length,1);await engine.close();await rate.close();
});
