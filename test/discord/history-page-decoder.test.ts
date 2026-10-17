import {it} from 'node:test';import assert from 'node:assert/strict';
import {decodeDiscordHistoryMessages,isDecodedGatewayMessage,joinDiscordHistoryDecoder,HISTORY_RESPONSE_MAX_BYTES} from '../../src/discord/gateway/decoded-message.ts';
const message=(id='9007199254740993')=>({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content:'한국어',embeds:[],id,type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00.123456+00:00',tts:false});
const bytes=(v:unknown)=>Buffer.from(JSON.stringify(v));
it('owned worker fully validates history page and returns immutable gateway-branded exact-ID messages',async()=>{
 const result=await decodeDiscordHistoryMessages(bytes([message(),message('9007199254740994')]));assert.equal(result.length,2);assert.ok(result.every(isDecodedGatewayMessage));assert.equal(result[0]!.id,9007199254740993n);assert.equal(result[1]!.id,9007199254740994n);assert.equal(result[0]!.timestamp.unixNanoseconds,1577836800123456000n);assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result[0]!.author));assert.equal(isDecodedGatewayMessage({...result[0]}),false);
});
it('all recognized nested message fields must validate before any page is returned',async()=>{
 for(const bad of [{...message(),author:{id:'2'}},{...message(),attachments:[{id:'3'}]},{...message(),timestamp:'not a timestamp'},{...message(),content:7}])await assert.rejects(decodeDiscordHistoryMessages(bytes([message(),bad])),SyntaxError);
});
it('fixed ten-message window accepts ten and rejects eleven, nonarray and malformed UTF8',async()=>{
 assert.equal((await decodeDiscordHistoryMessages(bytes(Array.from({length:10},(_,i)=>message(String(i+1)))))).length,10);for(const input of [bytes(Array.from({length:11},()=>message())),bytes(message()),Buffer.from([0xff]),Buffer.from('[{}')])await assert.rejects(decodeDiscordHistoryMessages(input),SyntaxError);
});
it('size and already-aborted inputs reject before worker creation and preserve reason',async()=>{
 await assert.rejects(decodeDiscordHistoryMessages(new Uint8Array(HISTORY_RESPONSE_MAX_BYTES+1)),RangeError);const c=new AbortController(),reason=new Error('stop');c.abort(reason);await assert.rejects(decodeDiscordHistoryMessages(bytes([]),c.signal),e=>e===reason);let hooks=0;const proxy=new Proxy(new Uint8Array(),{get(){hooks++;throw Error('trap');}});await assert.rejects(decodeDiscordHistoryMessages(proxy),TypeError);assert.equal(hooks,0);assert.deepEqual(await decodeDiscordHistoryMessages(bytes([])),[]);
});
it('zero-queue owner rejects concurrent decoding, cancellation joins exit before a later decode',async()=>{
 const c=new AbortController(),reason=new Error('stop'),first=decodeDiscordHistoryMessages(bytes([message()]),c.signal);const failed=assert.rejects(first,e=>e===reason);await assert.rejects(decodeDiscordHistoryMessages(bytes([])),/still running/);c.abort(reason);await failed;await joinDiscordHistoryDecoder();assert.equal((await decodeDiscordHistoryMessages(bytes([message()]))).length,1);
});

it('typed-array own accessors and iterator overrides are not invoked during bounded native copy',async()=>{
 const input=new Uint8Array(bytes([]));let hooks=0;Object.defineProperty(input,'byteLength',{get(){hooks++;throw Error('getter');}});Object.defineProperty(input,Symbol.iterator,{value(){hooks++;throw Error('iterator');}});assert.deepEqual(await decodeDiscordHistoryMessages(input),[]);assert.equal(hooks,0);
});
