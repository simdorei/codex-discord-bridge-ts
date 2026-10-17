import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseSerdeField,type StructField} from '../../src/core/serde-struct-json.ts';
import {decodeDiscordChannel as channel,discordPresenceField,discordPresenceActivityField,discordThreadMemberField,discordMemberField} from '../../src/discord/model/channel.ts';
const decode=(value:unknown,field:StructField)=>parseSerdeField(JSON.stringify(value),field) as Record<string,unknown>;
const chan=(extra:Record<string,unknown>={})=>channel(JSON.stringify({id:'1',type:11,...extra}));
const stamp='2020-01-01T00:00:00+00:00';
const user={id:'1',username:'x',discriminator:'0'};
const member={deaf:false,flags:0,mute:false,roles:[],user};
const presence={client_status:{},guild_id:'1',status:'online',user:{id:'1'}};

test('Channel requires exactly source identity and type while optional fields retain null',()=>{
 const v=chan();assert.equal(Object.keys(v).length,35);assert.equal(v.id,1n);assert.equal(v.type,11n);for(const [name,value] of Object.entries(v))if(name!=='id'&&name!=='type')assert.equal(value,null,name);
 for(const raw of ['{}','{"id":"1"}','{"type":1}','{"id":"0","type":1}','{"id":"1","type":256}'])assert.throws(()=>channel(raw),SyntaxError);
 assert.equal(chan({type:255}).type,255n);
});
test('channel bounds preserve signed member count and position without UI-derived constraints',()=>{
 const v=chan({member_count:-128,position:-2147483648,bitrate:4294967295,message_count:4294967295,user_limit:4294967295,rate_limit_per_user:65535,default_thread_rate_limit_per_user:65535,default_auto_archive_duration:65535});assert.equal(v.member_count,-128n);assert.equal(v.position,-2147483648n);assert.equal(v.default_auto_archive_duration,65535n);
 for(const extra of [{member_count:128},{member_count:-129},{position:2147483648},{bitrate:-1},{message_count:4294967296},{user_limit:1.5},{rate_limit_per_user:65536}])assert.throws(()=>chan(extra),SyntaxError);
});
test('all optional channel identity and enum fields validate when present',()=>{
 for(const name of ['application_id','guild_id','last_message_id','owner_id','parent_id'])assert.throws(()=>chan({[name]:'0'}),SyntaxError,name);
 for(const name of ['default_forum_layout','default_sort_order','video_quality_mode']){assert.equal(chan({[name]:255})[name],255n);assert.throws(()=>chan({[name]:256}),SyntaxError,name);}
 for(const name of ['invitable','managed','newly_created','nsfw'])assert.throws(()=>chan({[name]:0}),SyntaxError,name);
 assert.equal(chan({flags:255}).flags,18n);assert.throws(()=>chan({flags:'18'}),SyntaxError);
});
test('forum zeroable emoji requires explicit field, numeric zero/null accepted, string zero rejected',()=>{
 const tag={emoji_id:0,id:'1',moderated:false,name:''};let v=chan({available_tags:[tag]});assert.equal((v.available_tags as Record<string,unknown>[])[0]!.emoji_id,null);
 v=chan({available_tags:[{...tag,emoji_id:null},{...tag,emoji_id:'2'}]});assert.equal((v.available_tags as Record<string,unknown>[])[1]!.emoji_id,2n);
 for(const emoji_id of ['0','+0',-1,false,{},[]])assert.throws(()=>chan({available_tags:[{...tag,emoji_id}]}),SyntaxError);
 assert.throws(()=>chan({available_tags:[{id:'1',moderated:false,name:''}]}),SyntaxError);
});
test('forum reaction source does not enforce comment-only one-of emoji or tag text limits',()=>{
 assert.doesNotThrow(()=>chan({default_reaction_emoji:{}}));assert.doesNotThrow(()=>chan({default_reaction_emoji:{emoji_id:'1',emoji_name:'x'}}));
 assert.doesNotThrow(()=>chan({available_tags:[{emoji_id:1,emoji_name:'x',id:'2',moderated:true,name:'x'.repeat(100)}]}));assert.throws(()=>chan({default_reaction_emoji:{emoji_id:'0'}}),SyntaxError);
});
test('permission overwrites reuse unsigned string permissions and accept unknown target enum bytes',()=>{
 const v=chan({permission_overwrites:[{allow:'8',deny:0,id:'1',type:255}]});assert.deepEqual({...((v.permission_overwrites as Record<string,unknown>[])[0]!)},{allow:8n,deny:0n,id:1n,type:255n});
 for(const permission_overwrites of [[{allow:0,deny:0,id:'1'}],[{allow:'-1',deny:0,id:'1',type:0}],[{allow:0,deny:0,id:'0',type:0}]])assert.throws(()=>chan({permission_overwrites}),SyntaxError);
});
test('thread metadata requires archive fields, defaults locked false and allows unknown duration',()=>{
 const thread_metadata={archived:false,auto_archive_duration:7,archive_timestamp:stamp};const v=chan({thread_metadata}).thread_metadata as Record<string,unknown>;assert.equal(v.locked,false);assert.equal(v.auto_archive_duration,7n);assert.equal(v.create_timestamp,null);
 for(const key of Object.keys(thread_metadata)){const copy={...thread_metadata} as Record<string,unknown>;delete copy[key];assert.throws(()=>chan({thread_metadata:copy}),SyntaxError,key);}
 assert.throws(()=>chan({thread_metadata:{...thread_metadata,locked:null}}),SyntaxError);
});
test('thread member owns complete Member and Presence model validation without injecting guild id',()=>{
 const v=decode({flags:0,join_timestamp:stamp,member,presence},discordThreadMemberField);assert.equal(v.id,null);assert.equal(v.user_id,null);assert.equal((v.member as Record<string,unknown>).pending,false);
 assert.throws(()=>decode({join_timestamp:stamp},discordThreadMemberField),SyntaxError);assert.throws(()=>decode({flags:0,join_timestamp:stamp,presence:{client_status:{},status:'online',user:{id:'1'}}},discordThreadMemberField),SyntaxError);
});
test('Member user and flags are required while pending is an independently declared default',()=>{
 const v=decode(member,discordMemberField);assert.equal(v.pending,false);assert.equal(v.premium_since,null);assert.equal((v.user as Record<string,unknown>).id,1n);
 for(const key of ['flags','user','roles','deaf','mute']){const copy={...member} as Record<string,unknown>;delete copy[key];assert.throws(()=>decode(copy,discordMemberField),SyntaxError,key);}
 assert.throws(()=>decode({...member,pending:null},discordMemberField),SyntaxError);
});
test('Presence statuses are closed strings or externally tagged units',()=>{
 for(const status of ['dnd','idle','invisible','offline','online'])assert.equal(decode({...presence,status},discordPresenceField).status,status);
 assert.equal(decode({...presence,status:{online:null},client_status:{desktop:{idle:null},mobile:'offline',web:null}},discordPresenceField).status,'online');
 for(const status of ['ONLINE','future',0,null,{online:true},{online:null,idle:null}])assert.throws(()=>decode({...presence,status},discordPresenceField),SyntaxError);
 assert.throws(()=>parseSerdeField('{"client_status":{},"guild_id":"1","status":{"online":null,"online":null},"user":{"id":"1"}}',discordPresenceField),SyntaxError);
});
test('UserOrId buffered fallback accepts partial User fields but never invalid whole Content',()=>{
 const a=decode(presence,discordPresenceField).user as Record<string,unknown>;assert.deepEqual(a,{kind:'UserId',id:1n});
 assert.equal((decode({...presence,user},discordPresenceField).user as Record<string,unknown>).kind,'User');
 assert.equal((decode({...presence,user:{id:'1',username:12,bot:null}},discordPresenceField).user as Record<string,unknown>).kind,'UserId');
 assert.throws(()=>decode({...presence,user:{id:'0'}},discordPresenceField),SyntaxError);
 assert.throws(()=>parseSerdeField('{"client_status":{},"guild_id":"1","status":"online","user":{"id":"1","future":1e400}}',discordPresenceField));
});
test('Presence Activity requires name, defaults type and buttons, and validates known optional fields',()=>{
 const a=decode({name:''},discordPresenceActivityField),b=decode({name:''},discordPresenceActivityField);assert.equal(a.type,0n);assert.deepEqual(a.buttons,[]);assert.notEqual(a.buttons,b.buttons);
 assert.equal(decode({name:'',type:255,flags:1023},discordPresenceActivityField).flags,511n);
 for(const extra of [{name:null},{type:null},{created_at:-1},{application_id:'0'},{instance:0},{emoji:{}},{assets:{large_image:1}},{timestamps:{start:-1}},{secrets:{match:1}}])assert.throws(()=>decode({name:'x',...extra},discordPresenceActivityField),SyntaxError);
});
test('activity buttons are exactly textual strings or complete link maps, never sequences or Unknown',()=>{
 const v=decode({name:'',buttons:['label',{label:'',url:'not-a-url'}]},discordPresenceActivityField);assert.deepEqual(v.buttons,[{kind:'Text',label:'label'},{kind:'Link',label:'',url:'not-a-url'}]);
 for(const button of [null,1,[],['a','b'],{}, {label:'a'},{label:'a',url:null}])assert.throws(()=>decode({name:'',buttons:[button]},discordPresenceActivityField),SyntaxError);
 assert.throws(()=>parseSerdeField('{"name":"x","buttons":[{"label":"a","label":"b","url":"u"}]}',discordPresenceActivityField),SyntaxError);
 assert.doesNotThrow(()=>parseSerdeField('{"name":"x","buttons":[{"label":"a","url":"u","future":1e400}]}',discordPresenceActivityField));
});
test('activity party size uses exactly two lossless u64 elements and emoji id is arbitrary string',()=>{
 const v=decode({name:'',party:{size:[0,2]},emoji:{name:'e',id:'not-a-snowflake'}},discordPresenceActivityField);assert.deepEqual((v.party as Record<string,unknown>).size,[0n,2n]);
 for(const size of [[],[1],[1,2,3],[-1,2],[1.5,2]])assert.throws(()=>decode({name:'',party:{size}},discordPresenceActivityField),SyntaxError);
 const wide=parseSerdeField('{"name":"x","party":{"size":[18446744073709551615,0]}}',discordPresenceActivityField) as Record<string,unknown>;assert.deepEqual((wide.party as Record<string,unknown>).size,[18446744073709551615n,0n]);
});
test('actual Channel nested thread presence traversal reaches every activity child',()=>{
 const v=chan({member:{flags:0,join_timestamp:stamp,member,presence:{...presence,activities:[{name:'game',assets:{large_image:'x'},buttons:['a'],emoji:{name:'e'},party:{size:[1,2]},secrets:{join:'j'},timestamps:{start:0,end:1}}]}}});
 assert.equal((((v.member as Record<string,unknown>).presence as Record<string,unknown>).activities as Record<string,unknown>[])[0]!.name,'game');
 assert.throws(()=>chan({member:{flags:0,join_timestamp:stamp,presence:{...presence,activities:[{name:'game',party:{size:[1]}}]}}}),SyntaxError);
});
test('Channel sequence exact field order and nested duplicates stay strict',()=>{
 const values=Array.from({length:35},()=>null) as unknown[];values[12]='1';values[14]=255;assert.equal(channel(JSON.stringify(values)).type,255n);
 assert.throws(()=>channel(JSON.stringify(values.slice(0,34))),SyntaxError);
 assert.throws(()=>channel('{"id":"1","type":1,"member_count":null,"member_count":1}'),SyntaxError);
 assert.doesNotThrow(()=>channel('{"id":"1","type":1,"unknown":1e400,"unknown":"\\ud800"}'));
});
