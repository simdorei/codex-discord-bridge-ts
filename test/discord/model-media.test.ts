import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeDiscordAttachment as attachment,decodeDiscordEmbed as embed} from '../../src/discord/model/media.ts';
import {parseDiscordTimestamp as timestamp,modelTimestamp} from '../../src/discord/model/timestamp.ts';
import {parseSerdeField} from '../../src/core/serde-struct-json.ts';
const file={id:'1',filename:'',proxy_url:'not-a-url',size:0,url:'also-not-a-url'};
test('timestamp retains naive local fields rather than converting input offset to UTC',()=>{
 assert.equal(timestamp('1970-01-01T00:00:00+00:00').unixNanoseconds,0n);assert.equal(timestamp('1970-01-01T00:00:00+09:30').unixNanoseconds,0n);assert.equal(timestamp('1969-12-31T23:59:59.999999999+00:00').unixNanoseconds,-1n);
});
test('source minimum length rejects short Z timestamps while fractional Z is accepted',()=>{
 assert.throws(()=>timestamp('2020-01-01T00:00:00Z'),/length/);assert.doesNotThrow(()=>timestamp('2020-01-01T00:00:00.0000z'));assert.throws(()=>parseSerdeField('1',modelTimestamp),SyntaxError);
});
test('any one ASCII separator is accepted, but multibyte and malformed calendar fields are rejected',()=>{
 for(const separator of ['T','t',' ','X','\0','\n','\x7f'])assert.doesNotThrow(()=>timestamp(`2020-02-29${separator}01:02:03+00:00`));for(const text of ['2019-02-29T00:00:00+00:00','2020-02-30T00:00:00+00:00','2020-01-01é00:00:00+00:00','2020-01-01T24:00:00+00:00','2020-01-01T00:60:00+00:00','2020-01-01T00:00:61+00:00','2020-01-01T00:00:00+24:00','2020-01-01T00:00:00+00:60','2020-01-01T00:00:00+00:00\n'])assert.throws(()=>timestamp(text),SyntaxError,text);
});
test('subseconds truncate after nine digits and do not roll over calendar dates',()=>{
 assert.equal(timestamp('1970-01-01T00:00:00.123456789999+00:00').unixNanoseconds,123456789n);assert.equal(timestamp('1970-01-01T00:00:00.9+00:00').unixNanoseconds,900000000n);assert.throws(()=>timestamp('1970-01-01T00:00:00.+00:00'),SyntaxError);
});
test('leap seconds require UTC month end but preserve the source local wall-time representation',()=>{
 assert.equal(timestamp('1970-01-31T23:59:60+00:00').unixNanoseconds,timestamp('1970-01-31T23:59:59.999999999+00:00').unixNanoseconds);assert.doesNotThrow(()=>timestamp('2020-01-01T08:59:60+09:00'));assert.throws(()=>timestamp('2020-01-01T00:00:60+00:00'),SyntaxError);assert.throws(()=>timestamp('2020-01-30T23:59:60+00:00'),SyntaxError);assert.doesNotThrow(()=>timestamp('2021-02-28T23:59:60+00:00'));
});
test('year zero and far future timestamps remain lossless beyond nanosecond i64 range',()=>{
 assert.doesNotThrow(()=>timestamp('0000-02-29T00:00:00+00:00'));assert.ok(timestamp('9999-12-31T23:59:59+00:00').unixNanoseconds>(1n<<63n));assert.throws(()=>timestamp('10000-01-01T00:00:00+00:00'),SyntaxError);
});
test('minimal attachment preserves source defaults without inventing filename/url/waveform validation',()=>{
 const v=attachment(JSON.stringify({...file,waveform:'not-base64'}));assert.equal(v.id,1n);assert.equal(v.size,0n);assert.equal(v.ephemeral,false);assert.equal(v.width,null);assert.equal(v.waveform,'not-base64');
});
test('attachment accepts source f64 duration including negatives and truncates unknown flag bits',()=>{
 const v=attachment('{"id":"1","filename":"f","proxy_url":"p","url":"u","size":18446744073709551615,"duration_secs":-1.25,"flags":18446744073709551615,"width":18446744073709551615}');assert.equal(v.size,18446744073709551615n);assert.equal(v.width,18446744073709551615n);assert.equal(v.duration_secs,-1.25);assert.equal(v.flags,4n);
});
test('attachment rejects missing required fields, wrong scalar types and duplicate identity',()=>{
 for(const extra of [{id:'0'},{size:-1},{ephemeral:null},{width:1.5},{height:'1'}])assert.throws(()=>attachment(JSON.stringify({...file,...extra})),SyntaxError);assert.throws(()=>attachment('{"id":"1","id":"2","filename":"f","proxy_url":"p","url":"u","size":0}'),SyntaxError);assert.throws(()=>attachment('{"id":"1"}'),SyntaxError);
});
test('minimal embed requires only its actual required type and gets independently owned defaults',()=>{
 const a=embed('{"type":"unknown-future"}'),b=embed('{"type":"rich"}');assert.equal(a.author,null);assert.equal(a.color,null);assert.deepEqual(a.fields,[]);assert.notEqual(a.fields,b.fields);(a.fields as unknown[]).push('changed');assert.deepEqual(b.fields,[]);assert.deepEqual(embed('{"type":"rich"}').fields,[]);assert.throws(()=>embed('{}'),SyntaxError);
});
test('embed author/footer/image/video/provider/field complete structures follow source optionality',()=>{
 const v=embed(JSON.stringify({type:'rich',author:{name:''},fields:[{name:'n',value:'v'}],footer:{text:''},image:{url:''},thumbnail:{url:''},provider:{},video:{},timestamp:'1970-01-01T00:00:00+00:00',color:4294967295}));assert.equal((v.author as Record<string,unknown>).icon_url,null);assert.equal(((v.fields as Record<string,unknown>[])[0]!).inline,false);assert.equal((v.video as Record<string,unknown>).url,null);assert.equal((v.timestamp as {unixNanoseconds:bigint}).unixNanoseconds,0n);assert.equal(v.color,4294967295n);
});
test('nested malformed embed fields fail even when outer type is valid',()=>{
 for(const extra of [{author:{}},{footer:{}},{image:{}},{thumbnail:{url:null}},{fields:null},{fields:[{name:'n'}]},{fields:[{name:'n',value:'v',inline:1}]},{timestamp:'2020-01-01T00:00:00Z'},{color:4294967296}])assert.throws(()=>embed(JSON.stringify({type:'rich',...extra})),SyntaxError);assert.throws(()=>embed('{"type":"rich","author":{"name":"a","name":"b"}}'),SyntaxError);
});
test('attachment and embed complete sequences preserve declared field order',()=>{
 const a=attachment(JSON.stringify([null,false,null,'f',null,null,null,'1','p',0,null,'u',null,null]));assert.equal(a.id,1n);assert.throws(()=>attachment(JSON.stringify([null,false,null,'f',null,null,null,'1','p',0,null,'u',null])),SyntaxError);const e=embed(JSON.stringify([null,null,null,[],null,null,'rich',null,null,null,null,null,null]));assert.equal(e.type,'rich');assert.throws(()=>embed(JSON.stringify([null,null,null,[],null,null,'rich'])),SyntaxError);
});
test('nested unknown fields retain typed ignored-value semantics',()=>{
 assert.equal((embed('{"type":"rich","author":{"name":"a","future":1e400,"future":"\\ud800"}}').author as Record<string,unknown>).name,'a');assert.throws(()=>embed('{"type":"rich","author":{"name":"\\ud800"}}'),SyntaxError);
});
