import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeDiscordSimpleDispatch as decode,discordSimpleDispatchField} from '../../src/discord/model/gateway-dispatch-simple.ts';
import {decodeGatewayDispatchPayload} from '../../src/discord/gateway/dispatch-envelope.ts';
const user={id:'2',username:'u',discriminator:'0'};
const role={color:0,colors:{primary_color:0},hoist:false,id:'2',managed:false,mentionable:false,name:'',permissions:'0',position:-1,flags:0};
const stage={channel_id:'1',guild_id:'2',id:'3',privacy_level:2,topic:''};
const reaction={burst:false,channel_id:'1',emoji:{name:'x'},message_id:'2',user_id:'3'};
const fixtures:readonly [string,Record<string,unknown>,string][]=[
 ['STAGE_INSTANCE_CREATE',stage,'privacy_level'],['STAGE_INSTANCE_UPDATE',stage,'topic'],['STAGE_INSTANCE_DELETE',stage,'channel_id'],
 ['GUILD_MEMBER_REMOVE',{guild_id:'1',user},'user'],
 ['PRESENCE_UPDATE',{client_status:{},guild_id:'1',status:'online',user:{id:'2'}},'client_status'],
 ['TYPING_START',{channel_id:'1',timestamp:0,user_id:'2'},'timestamp'],
 ['THREAD_LIST_SYNC',{guild_id:'1',members:[],threads:[]},'members'],
 ['MESSAGE_REACTION_ADD',reaction,'burst'],['MESSAGE_REACTION_REMOVE',reaction,'emoji'],
 ['THREAD_CREATE',{id:'1',type:11},'id'],['THREAD_UPDATE',{id:'1',type:12},'type'],
 ['GUILD_ROLE_CREATE',{guild_id:'1',role},'role'],['GUILD_ROLE_UPDATE',{guild_id:'1',role},'guild_id'],
 ['INTEGRATION_DELETE',{guild_id:'1',id:'2'},'id'],['VOICE_SERVER_UPDATE',{guild_id:'1',token:'offline-fixture'},'token'],
 ['MESSAGE_REACTION_REMOVE_ALL',{channel_id:'1',message_id:'2'},'message_id'],
 ['MESSAGE_REACTION_REMOVE_EMOJI',{channel_id:'1',emoji:{name:'x'},guild_id:'2',message_id:'3'},'emoji'],
 ['GUILD_SCHEDULED_EVENT_USER_ADD',{guild_id:'1',guild_scheduled_event_id:'2',user_id:'3'},'user_id'],
 ['GUILD_SCHEDULED_EVENT_USER_REMOVE',{guild_id:'1',guild_scheduled_event_id:'2',user_id:'3'},'guild_scheduled_event_id'],
 ['CHANNEL_CREATE',{id:'1',type:0},'id'],['CHANNEL_UPDATE',{id:'1',type:255},'type'],['CHANNEL_DELETE',{id:'1',type:0},'id'],
 ['CHANNEL_PINS_UPDATE',{channel_id:'1'},'channel_id'],
 ['ENTITLEMENT_CREATE',{application_id:'1',deleted:false,id:'2',sku_id:'3',type:1},'sku_id'],
 ['USER_UPDATE',{...user,mfa_enabled:false},'mfa_enabled'],
 ['GUILD_BAN_ADD',{guild_id:'1',user},'user'],['GUILD_BAN_REMOVE',{guild_id:'1',user},'guild_id'],
 ['GUILD_DELETE',{id:'1'},'id'],['GUILD_INTEGRATIONS_UPDATE',{guild_id:'1'},'guild_id'],
 ['GUILD_ROLE_DELETE',{guild_id:'1',role_id:'2'},'role_id'],
 ['INVITE_DELETE',{channel_id:'1',code:'',guild_id:'2'},'guild_id'],
 ['MESSAGE_DELETE',{channel_id:'1',id:'2'},'id'],['MESSAGE_DELETE_BULK',{channel_id:'1',ids:[]},'ids'],
 ['MESSAGE_POLL_VOTE_ADD',{answer_id:255,channel_id:'1',message_id:'2',user_id:'3'},'answer_id'],
 ['MESSAGE_POLL_VOTE_REMOVE',{answer_id:0,channel_id:'1',message_id:'2',user_id:'3'},'user_id'],
 ['THREAD_DELETE',{guild_id:'1',id:'2',type:255,parent_id:'3'},'parent_id'],
 ['WEBHOOKS_UPDATE',{channel_id:'1',guild_id:'2'},'guild_id'],
];
for(const [name,value,required] of fixtures)test(name+' validates its source-required fields and envelope',()=>{const raw=JSON.stringify(value),result=decode(name,raw);assert.equal(Object.getPrototypeOf(result),null);const field=discordSimpleDispatchField(name)!;assert.deepEqual(decodeGatewayDispatchPayload(JSON.stringify({op:0,t:name,s:1,d:value}),name,field),result);const missing={...value};delete missing[required];assert.throws(()=>decode(name,JSON.stringify(missing)));assert.throws(()=>decode(name,raw.slice(0,-1)+','+JSON.stringify(required)+':null}'));assert.doesNotThrow(()=>decode(name,raw.slice(0,-1)+',"future":1e999}'));});
test('source optional fields differ from required InviteDelete guild identity',()=>{assert.equal(decode('CHANNEL_PINS_UPDATE','{"channel_id":"1"}').last_pin_timestamp,null);assert.equal(decode('GUILD_DELETE','{"id":"1","unavailable":false}').unavailable,false);assert.equal(decode('MESSAGE_DELETE','{"channel_id":"1","id":"2"}').guild_id,null);assert.throws(()=>decode('INVITE_DELETE','{"channel_id":"1","code":"x","guild_id":null}'));assert.throws(()=>decode('CHANNEL_PINS_UPDATE','{"channel_id":"1","last_pin_timestamp":"invalid"}'));});
test('vote answer is u8, not u32 or a snowflake; unknown channel kind remains open u8',()=>{for(const name of ['MESSAGE_POLL_VOTE_ADD','MESSAGE_POLL_VOTE_REMOVE']){const base={channel_id:'1',message_id:'2',user_id:'3'};for(const answer_id of [-1,256,'1',null])assert.throws(()=>decode(name,JSON.stringify({...base,answer_id})));assert.throws(()=>decode(name,'{"answer_id":1.0,"channel_id":"1","message_id":"2","user_id":"3"}'));}assert.equal(decode('THREAD_DELETE','{"guild_id":"1","id":"2","type":255,"parent_id":"3"}').type,255n);});
test('wrapper child validation is complete and UserUpdate requires CurrentUser MFA field',()=>{assert.throws(()=>decode('GUILD_BAN_ADD','{"guild_id":"1","user":{"id":"2"}}'));assert.throws(()=>decode('USER_UPDATE',JSON.stringify(user)));assert.throws(()=>decode('CHANNEL_CREATE','{"id":"1","type":0,"permission_overwrites":[{}]}'));assert.throws(()=>decode('MESSAGE_DELETE_BULK','{"channel_id":"1","ids":["0"]}'));});
test('partial schema registry never pretends unsupported known events are ignored',()=>{assert.equal(discordSimpleDispatchField('GUILD_CREATE'),undefined);assert.equal(discordSimpleDispatchField('__proto__'),undefined);assert.throws(()=>decode('GUILD_CREATE','{}'));});

test('stage privacy has one closed discriminant, even though channel kind is open',()=>{for(const name of ['STAGE_INSTANCE_CREATE','STAGE_INSTANCE_UPDATE','STAGE_INSTANCE_DELETE']){for(const privacy_level of [0,1,3,255,'2',null])assert.throws(()=>decode(name,JSON.stringify({...stage,privacy_level})));assert.equal(decode(name,JSON.stringify(stage)).guild_scheduled_event_id,null);}});
test('nested thread/member and reaction fields are not accepted by shallow identities',()=>{assert.throws(()=>decode('THREAD_LIST_SYNC','{"guild_id":"1","members":[{"id":"2"}],"threads":[]}'));assert.throws(()=>decode('THREAD_LIST_SYNC','{"guild_id":"1","members":[],"threads":[{"id":"2"}]}'));assert.throws(()=>decode('TYPING_START','{"channel_id":"1","timestamp":0,"user_id":"2","member":{}}'));assert.throws(()=>decode('MESSAGE_REACTION_ADD',JSON.stringify({...reaction,burst_colors:['bad']})));assert.equal(decode('MESSAGE_REACTION_REMOVE',JSON.stringify(reaction)).member,null);assert.deepEqual(decode('THREAD_LIST_SYNC','{"guild_id":"1","members":[],"threads":[]}').channel_ids,[]);});
