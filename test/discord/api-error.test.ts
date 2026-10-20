import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseDiscordApiError as parse} from '../../src/discord/api-error.ts';
test('general error preserves full u64 and precedes valid later variants',()=>{
 assert.deepEqual(parse('{"code":18446744073709551615,"message":"denied","global":true,"retry_after":2,"embed":["fields"]}'),{kind:'General',code:18446744073709551615n,message:'denied'});assert.deepEqual(parse('[0,"zero"]'),{kind:'General',code:0n,message:'zero'});
});
test('ratelimit f64 permits source negative and fractional values without making retry policy',()=>{
 assert.deepEqual(parse('{"global":true,"message":"slow","retry_after":1.25}'),{kind:'Ratelimited',global:true,message:'slow',retryAfter:1.25});assert.deepEqual(parse('[false,"slow",-2]'),{kind:'Ratelimited',global:false,message:'slow',retryAfter:-2});
});
test('Message fallback accepts empty/unknown maps and missing or null embed',()=>{
 for(const raw of ['{}','{"unknown":true}','{"code":-1,"message":"bad code"}','{"embed":null}'])assert.deepEqual(parse(raw),{kind:'Message',embed:null});assert.deepEqual(parse('[null]'),{kind:'Message',embed:null});
});
test('embed unit variants preserve strings and externally tagged null forms',()=>{
 assert.deepEqual(parse('{"embed":["fields","timestamp",{"fields":null},{"timestamp":null}]}'),{kind:'Message',embed:['fields','timestamp','fields','timestamp']});assert.deepEqual(parse('[["fields"]]'),{kind:'Message',embed:['fields']});
});
test('invalid General representation falls through instead of inventing a general error',()=>{
 for(const code of ['1.0','1e0','-1','"1"','18446744073709551616'])assert.deepEqual(parse(`{"code":${code},"message":"bad","embed":["fields"]}`),{kind:'Message',embed:['fields']});
});
test('duplicate recognized fields invalidate a variant, while unknown duplicates can remain ignored',()=>{
 assert.deepEqual(parse('{"code":1,"code":2,"message":"duplicate"}'),{kind:'Message',embed:null});assert.deepEqual(parse('{"unrelated":1,"unrelated":2}'),{kind:'Message',embed:null});assert.throws(()=>parse('{"embed":null,"embed":null}'),SyntaxError);assert.throws(()=>parse('{"embed":[{"fields":null,"fields":null}]}'),SyntaxError);
});
test('all variants reject malformed root/array lengths and invalid embed values',()=>{
 for(const raw of ['null','true','1','"error"','[]','[null,null]','{"embed":0}','{"embed":["unknown"]}','{"embed":[{"fields":true}]}','{"embed":[{"fields":null,"extra":null}]}'])assert.throws(()=>parse(raw),SyntaxError,raw);
});
test('untagged buffering rejects invalid Unicode and overflow even in ignored fields',()=>{
 assert.throws(()=>parse('{"code":1,"message":"x","unknown":"\\ud800"}'),SyntaxError);assert.throws(()=>parse('{"unknown":1e400}'),RangeError);assert.throws(()=>parse('{"unknown":"\\ud800","unknown":0}'),SyntaxError);assert.throws(()=>parse('{bad'),SyntaxError);
});
test('returned models and embed vectors are immutable and no caller object is inspected',()=>{
 const v=parse('{"embed":["fields"]}');assert.equal(Object.isFrozen(v),true);if(v.kind==='Message')assert.equal(Object.isFrozen(v.embed),true);assert.throws(()=>parse({toString(){throw new Error('hook');}} as never),TypeError);
});
