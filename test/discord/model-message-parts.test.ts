import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseSerdeField,type StructField} from '../../src/core/serde-struct-json.ts';
import * as part from '../../src/discord/model/message-parts.ts';
const decode=(value:unknown,field:StructField)=>parseSerdeField(JSON.stringify(value),field) as Record<string,unknown>;
const member={deaf:false,flags:0,mute:false,roles:[]};
const user={id:'1',username:'u',discriminator:'0'};
const stamp='2020-01-01T00:00:00+00:00';

test('permissions accepts unsigned decimal text and integer but truncates only unknown source bits',()=>{
 const mask=((1n<<47n)-1n)|(15n<<49n);
 for(const raw of ['18446744073709551615','"18446744073709551615"','"+00018446744073709551615"'])assert.equal(parseSerdeField(raw,part.discordPermissionsField),mask);
 for(const raw of ['"1\n"','-1','1.0','true','null','"-1"','18446744073709551616','"18446744073709551616"'])assert.throws(()=>parseSerdeField(raw,part.discordPermissionsField),raw);
 assert.equal(parseSerdeField('"0"',part.discordPermissionsField),0n);
});
test('partial member requires all source booleans, flags and roles but permits missing optional dates',()=>{
 const v=decode(member,part.discordPartialMemberField);assert.equal(v.avatar,null);assert.equal(v.joined_at,null);assert.equal(v.user,null);assert.deepEqual(v.roles,[]);
 for(const key of ['deaf','flags','mute','roles']){const copy={...member} as Record<string,unknown>;delete copy[key];assert.throws(()=>decode(copy,part.discordPartialMemberField),SyntaxError,key);}
 for(const extra of [{roles:['0']},{flags:'0'},{deaf:null},{mute:0},{roles:null},{permissions:1.0+0.5},{user:{}},{avatar:'hash'},{joined_at:'2020-01-01T00:00:00Z'}])assert.throws(()=>decode({...member,...extra},part.discordPartialMemberField),SyntaxError);
});
test('complete partial member reuses actual User, decoration, flags and timestamp decoding',()=>{
 const v=decode({...member,flags:255,roles:['1'],avatar_decoration_data:{asset:'0'.repeat(32),sku_id:'2'},user,joined_at:stamp,premium_since:stamp,communication_disabled_until:stamp,permissions:'8'},part.discordPartialMemberField);
 assert.equal(v.flags,15n);assert.equal((v.user as Record<string,unknown>).id,1n);assert.equal(v.permissions,8n);assert.equal((v.avatar_decoration_data as Record<string,unknown>).sku_id,2n);
});
test('Mention requires public flags, accepts discriminator text and retains bot default',()=>{
 const v=decode({...user,public_flags:0,member},part.discordMentionField);assert.equal(v.bot,false);assert.equal(v.discriminator,0n);assert.equal(v.avatar,null);
 assert.throws(()=>decode(user,part.discordMentionField),SyntaxError);assert.throws(()=>decode({...user,public_flags:null},part.discordMentionField),SyntaxError);
 const wide=parseSerdeField('{"username":"u","id":"1","discriminator":65535,"public_flags":18446744073709551615}',part.discordMentionField) as Record<string,unknown>;assert.equal(wide.discriminator,65535n);assert.ok((wide.public_flags as bigint)<(1n<<23n));
});
test('channel mentions, activity and stickers accept unknown byte enums and enforce required identities',()=>{
 assert.equal(decode({guild_id:'1',id:'2',type:255,name:''},part.discordChannelMentionField).type,255n);
 assert.equal(decode({type:255},part.discordMessageActivityField).party_id,null);
 assert.equal(decode({format_type:255,id:'1',name:''},part.discordMessageStickerField).format_type,255n);
 for(const [value,field] of [[{id:'2',type:1,name:''},part.discordChannelMentionField],[{type:256},part.discordMessageActivityField],[{format_type:1,id:'0',name:''},part.discordMessageStickerField]] as const)assert.throws(()=>decode(value,field),SyntaxError);
});
test('MessageApplication preserves optional image hashes without inventing required icon',()=>{
 const v=decode({id:'1',description:'',name:''},part.discordMessageApplicationField);assert.equal(v.cover_image,null);assert.equal(v.icon,null);
 assert.equal(decode({id:'1',description:'',name:'',icon:'clyde-anything'},part.discordMessageApplicationField).icon,'clyde');assert.throws(()=>decode({id:'1',name:''},part.discordMessageApplicationField),SyntaxError);
});
test('MessageCall defaults participants independently and validates every participant identity',()=>{
 const a=decode({},part.discordMessageCallField),b=decode({},part.discordMessageCallField);assert.equal(a.ended_timestamp,null);assert.deepEqual(a.participants,[]);assert.notEqual(a.participants,b.participants);
 assert.equal((decode({participants:['1','2'],ended_timestamp:stamp},part.discordMessageCallField).participants as bigint[])[1],2n);
 assert.throws(()=>decode({participants:['0']},part.discordMessageCallField),SyntaxError);
});
test('legacy interaction types are closed enums unlike message and channel types',()=>{
 for(const type of [1,2,3,4,5])assert.equal(decode({id:'1',type,name:'',user,member},part.discordMessageInteractionField).type,BigInt(type));
 for(const type of [0,6,255])assert.throws(()=>decode({id:'1',type,name:'',user},part.discordMessageInteractionField),SyntaxError);
 assert.throws(()=>decode({id:'1',type:2,name:''},part.discordMessageInteractionField),SyntaxError);
});
test('reference defaults source type but does not turn optional fail_if_not_exists into true',()=>{
 const v=decode({},part.discordMessageReferenceField);assert.equal(v.type,0n);assert.equal(v.fail_if_not_exists,null);assert.equal(v.channel_id,null);
 assert.equal(decode({type:255,fail_if_not_exists:false},part.discordMessageReferenceField).type,255n);assert.throws(()=>decode({type:null},part.discordMessageReferenceField),SyntaxError);
});
test('subscription months use u16 and source required renewal/name fields',()=>{
 const v=decode({is_renewal:false,role_subscription_listing_id:'1',tier_name:'',total_months_subscribed:65535},part.discordRoleSubscriptionField);assert.equal(v.total_months_subscribed,65535n);
 for(const extra of [{total_months_subscribed:65536},{is_renewal:null},{role_subscription_listing_id:'0'}])assert.throws(()=>decode({is_renewal:true,role_subscription_listing_id:'1',tier_name:'x',total_months_subscribed:0,...extra},part.discordRoleSubscriptionField),SyntaxError);
});
test('message snapshots validate complete minimal subset and recursively validate supplied models',()=>{
 const message={attachments:[],content:'',embeds:[],type:255,timestamp:stamp};
 const v=decode({message},part.discordMessageSnapshotField),m=v.message as Record<string,unknown>;assert.equal(v.guild_id,null);for(const key of ['components','mentions','mention_roles','sticker_items'])assert.deepEqual(m[key],[]);
 assert.throws(()=>decode({message:{...message,components:[{type:2}]}},part.discordMessageSnapshotField),SyntaxError);assert.throws(()=>decode({message:{...message,mentions:[user]}},part.discordMessageSnapshotField),SyntaxError);
 const flags=parseSerdeField('18446744073709551615',part.discordMessageFlagsField);assert.equal(flags,45567n);
});
test('HexColor keeps source short-nibble, repeated-hash and positive-radix parsing',()=>{
 for(const [input,expected] of [['#abc',[10,11,12]],['###aBc',[10,11,12]],['#aAbBcC',[170,187,204]],['#+f+0+1',[15,0,1]]] as const)assert.deepEqual(parseSerdeField(JSON.stringify(input),part.discordHexColorField),expected);
 for(const input of ['abc','#abcd','#ggg','#abcdef\n','#１２３','#éa'])assert.throws(()=>parseSerdeField(JSON.stringify(input),part.discordHexColorField),SyntaxError,input);
});
test('Reaction requires counts, both current-user flags and complete color/emoji validation',()=>{
 const reaction={burst_colors:['#abc'],count:0,count_details:{burst:0,normal:0},emoji:{name:'👍'},me:false,me_burst:false};
 assert.deepEqual(decode(reaction,part.discordReactionField).burst_colors,[[10,11,12]]);
 for(const key of Object.keys(reaction)){const copy={...reaction} as Record<string,unknown>;delete copy[key];assert.throws(()=>decode(copy,part.discordReactionField),SyntaxError,key);}
 assert.throws(()=>decode({...reaction,count_details:{burst:0}},part.discordReactionField),SyntaxError);
});
test('Poll media has optional fields and partial emoji differs from reaction emoji',()=>{
 const poll={answers:[{answer_id:0,poll_media:{emoji:{}}}],allow_multiselect:false,layout_type:255,question:{}};
 const v=decode(poll,part.discordPollField);assert.equal(v.expiry,null);assert.equal(v.results,null);assert.equal(v.layout_type,255n);
 const emoji=(((v.answers as Record<string,unknown>[])[0]!.poll_media as Record<string,unknown>).emoji as Record<string,unknown>);assert.equal(emoji.animated,false);assert.equal(emoji.id,null);assert.equal(emoji.name,null);
 const result=decode({...poll,results:{answer_counts:[{id:255,count:0,me_voted:true}],is_finalized:false}},part.discordPollField);assert.equal(((result.results as Record<string,unknown>).answer_counts as Record<string,unknown>[])[0]!.id,255n);
});
test('poll required values and nested ranges cannot be bypassed by otherwise valid outer content',()=>{
 const poll={answers:[],allow_multiselect:false,layout_type:1,question:{text:'q'}};
 for(const key of Object.keys(poll)){const copy={...poll} as Record<string,unknown>;delete copy[key];assert.throws(()=>decode(copy,part.discordPollField),SyntaxError,key);}
 for(const extra of [{answers:[{answer_id:256,poll_media:{}}]},{answers:[{answer_id:1,poll_media:{emoji:{id:'0'}}}]},{question:{text:1}},{results:{answer_counts:[],is_finalized:null}},{expiry:'bad'}])assert.throws(()=>decode({...poll,...extra},part.discordPollField),SyntaxError);
});
test('derived leaf sequence orders and duplicate checks remain intact',()=>{
 assert.equal(decode([null,null,null,null,false,0,null,false,null,null,null,[],null],part.discordPartialMemberField).flags,0n);
 assert.equal(decode([null,false,'0','1',null,'name',0],part.discordMentionField).username,'name');
 assert.equal(decode([null,null,0,null,null],part.discordMessageReferenceField).type,0n);
 assert.throws(()=>parseSerdeField('{"deaf":false,"flags":0,"flags":1,"mute":false,"roles":[]}',part.discordPartialMemberField),SyntaxError);
 assert.throws(()=>decode([null],part.discordMessageReferenceField),SyntaxError);
});
