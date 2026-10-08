import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeDiscordMessage as message,discordMessageDecoder,discordInteractionMetadataField} from '../../src/discord/model/message.ts';
import {parseSerdeField} from '../../src/core/serde-struct-json.ts';
const stamp='2020-01-01T00:00:00+00:00';
const user={id:'1',username:'u',discriminator:'0'};
const minimal={attachments:[],author:user,channel_id:'2',content:'',embeds:[],id:'3',type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:stamp,tts:false};
const decode=(value:unknown)=>message(JSON.stringify(value));
const metadata={authorizing_integration_owners:{},id:'4',type:2,user};
const meta=(raw:string)=>parseSerdeField(raw,discordInteractionMetadataField) as Record<string,unknown>;
const owners=(guildRaw:string,userRaw?:string)=>meta(`{"authorizing_integration_owners":{"0":${guildRaw}${userRaw===undefined?'':`,"1":${userRaw}`}},"id":"4","type":2,"user":${JSON.stringify(user)}}`).authorizing_integration_owners as Record<string,unknown>;

test('complete Message requires every source required field and cannot accept an id-only receipt',()=>{
 const v=decode(minimal);assert.equal(v.id,3n);assert.equal(Object.keys(v).length,34);assert.equal(v.call,null);assert.equal(v.thread,null);
 for(const key of Object.keys(minimal)){const copy={...minimal} as Record<string,unknown>;delete copy[key];assert.throws(()=>decode(copy),SyntaxError,key);}
 assert.throws(()=>message('{"id":"3"}'),SyntaxError);
});
test('Message vectors declared with defaults are independent while required vectors reject absence and null',()=>{
 const a=decode(minimal),b=decode(minimal);for(const key of ['components','mention_channels','message_snapshots','reactions','sticker_items']){assert.deepEqual(a[key],[]);assert.notEqual(a[key],b[key]);assert.throws(()=>decode({...minimal,[key]:null}),SyntaxError,key);}
 for(const key of ['attachments','embeds','mention_roles','mentions'])assert.throws(()=>decode({...minimal,[key]:null}),SyntaxError,key);
});
test('every optional Message family is actually traversed before receipt identity can be returned',()=>{
 const invalid={activity:{},application:{},application_id:'0',call:{participants:['0']},edited_timestamp:'bad',flags:-1,guild_id:'0',interaction:{},interaction_metadata:{},member:{},poll:{},message_reference:{type:256},referenced_message:{id:'3'},role_subscription_data:{},thread:{id:'1'},webhook_id:'0'};
 for(const [key,value] of Object.entries(invalid))assert.throws(()=>decode({...minimal,[key]:value}),key);
});
test('all nonempty recognized vectors reject malformed children despite a valid top-level id',()=>{
 for(const [key,value] of Object.entries({attachments:[{}],components:[{type:2}],embeds:[{}],mention_channels:[{}],mention_roles:['0'],mentions:[user],message_snapshots:[{}],reactions:[{}],sticker_items:[{}]}))assert.throws(()=>decode({...minimal,[key]:value}),SyntaxError,key);
});
test('valid rich Message composes optional families and nested channel presence without id-only shortcuts',()=>{
 const v=decode({...minimal,activity:{type:255},application:{id:'1',name:'',description:''},call:{},components:[{type:2,style:1}],embeds:[{type:'rich',fields:[{name:'n',value:'v'}]}],interaction:{id:'1',type:2,name:'',user},interaction_metadata:metadata,member:{deaf:false,flags:0,mute:false,roles:[]},mention_channels:[{guild_id:'1',id:'2',type:0,name:''}],mention_roles:['1'],mentions:[{...user,public_flags:0}],message_snapshots:[{message:{attachments:[],content:'',embeds:[],type:0,timestamp:stamp}}],poll:{answers:[],allow_multiselect:false,layout_type:1,question:{}},reactions:[{burst_colors:[],count:0,count_details:{burst:0,normal:0},emoji:{name:'x'},me:false,me_burst:false}],message_reference:{},referenced_message:minimal,role_subscription_data:{is_renewal:false,role_subscription_listing_id:'1',tier_name:'',total_months_subscribed:0},sticker_items:[{format_type:1,id:'1',name:''}],thread:{id:'2',type:11,member:{flags:0,join_timestamp:stamp,presence:{client_status:{},guild_id:'1',status:'online',user:{id:'1'}}}}});
 assert.equal((v.referenced_message as Record<string,unknown>).id,3n);assert.equal(((v.thread as Record<string,unknown>).member as Record<string,unknown>).flags,0n);
});
test('Metadata keeps required source fields, closed interaction type and recursive optional metadata',()=>{
 const a=meta(JSON.stringify(metadata));assert.equal(a.target_user,null);assert.equal(a.triggering_interaction_metadata,null);assert.deepEqual({...a.authorizing_integration_owners as Record<string,unknown>},{'0':null,'1':null});
 const b=meta(JSON.stringify({...metadata,triggering_interaction_metadata:metadata,target_user:user}));assert.equal((b.triggering_interaction_metadata as Record<string,unknown>).id,4n);
 for(const key of Object.keys(metadata)){const copy={...metadata} as Record<string,unknown>;delete copy[key];assert.throws(()=>meta(JSON.stringify(copy)),SyntaxError,key);}
 assert.throws(()=>meta(JSON.stringify({...metadata,type:255})),SyntaxError);
});
test('integration owners use zero-accepting anonymizable guild identity but strict nonzero user identity',()=>{
 for(const raw of ['0','"0"','"bad"','-1','1.5','true','false','[]','{}','1e400'])assert.equal(owners(raw)['0'],0n,raw);
 assert.equal(owners('null')['0'],null);assert.equal(owners('"+0009"')['0'],9n);assert.equal(owners('18446744073709551615')['0'],18446744073709551615n);
 for(const raw of ['0','"0"','false','{}'])assert.throws(()=>owners('0',raw),SyntaxError,raw);
 assert.equal(owners('0','"7"')['1'],7n);
});
test('AnonymizableId does not wrongly turn unread container content into a valid owner',()=>{
 for(const raw of ['[0]','[[]]','{"x":0}','{"0":"1"}'])assert.throws(()=>owners(raw),/Unconsumed/,raw);
 assert.equal(owners('[ \n\t ]')['0'],0n);assert.equal(owners('{ \r\n }')['0'],0n);
});
test('source swallowed unicode error only succeeds when its following byte consumed the final quote',()=>{
 assert.equal(owners('"\\ud800"')['0'],0n);assert.equal(owners('"prefix\\udbff"')['0'],0n);assert.equal(owners('"\\ud800\\udc00"')['0'],0n);
 for(const raw of ['"\\udc00"','"\\ud800a"','"\\ud800\\u0041"','"\\ud800\\ud800"'])assert.throws(()=>owners(raw),SyntaxError,raw);
});
test('source overflow error cannot hide remaining exponent digits',()=>{
 assert.equal(owners('1e2147483648')['0'],0n);assert.equal(owners('1e9999999999')['0'],0n);
 assert.throws(()=>owners('1e21474836480'),/Unconsumed/);assert.throws(()=>owners('1e99999999999'),/Unconsumed/);
 assert.equal(owners('0e999999999999999999999')['0'],0n);assert.equal(owners('1e-999999999999999999999')['0'],0n);
});
test('metadata known duplicate fields reject even null; unknown future integration owner kinds are ignored',()=>{
 assert.throws(()=>meta(`{"authorizing_integration_owners":{"0":null,"0":"1"},"id":"4","type":2,"user":${JSON.stringify(user)}}`),SyntaxError);
 assert.doesNotThrow(()=>meta(`{"authorizing_integration_owners":{"future":1e400},"id":"4","type":2,"user":${JSON.stringify(user)}}`));
});
test('Message and Metadata complete sequence orders remain source-defined',()=>{
 const values=[null,null,null,[],user,null,'2',[],'',null,[],null,null,'3',null,null,0,null,[],false,[],[],[],false,null,[],null,null,null,[],stamp,null,false,null];
 assert.equal(message(JSON.stringify(values)).id,3n);assert.throws(()=>message(JSON.stringify(values.slice(0,33))),SyntaxError);
 assert.equal(meta(JSON.stringify([{},'4',null,2,null,null,null,null,user])).id,4n);
});
test('receipt byte decoder rejects malformed UTF8, BOM and trailing values and exposes no partial identity',()=>{
 const bytes=Buffer.from(JSON.stringify(minimal));assert.equal(discordMessageDecoder.decode(bytes),3n);
 for(const bad of [Buffer.from([255]),Buffer.concat([Buffer.from([239,187,191]),bytes]),Buffer.from(JSON.stringify(minimal)+' {}'),Buffer.from('{"id":"3"}')])assert.throws(()=>discordMessageDecoder.decode(bad));
});
test('recursive Message and metadata share the bounded parser depth',()=>{
 let value:unknown=minimal;for(let i=0;i<124;i++)value={...minimal,referenced_message:value};assert.doesNotThrow(()=>decode(value));
 for(let i=0;i<4;i++)value={...minimal,referenced_message:value};assert.throws(()=>decode(value),/recursion/);
});
test('duplicate top-level identity rejects while unknown values keep ignored-field semantics',()=>{
 const raw=JSON.stringify(minimal);assert.throws(()=>message(raw.slice(0,-1)+',"id":"4"}'),SyntaxError);assert.equal(message(raw.slice(0,-1)+',"future":1e400,"future":"\\ud800"}').id,3n);
});
