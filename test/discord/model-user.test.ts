import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeDiscordUser,discordUserField,discordUserShape,modelImageHash,modelSnowflake,modelOption,modelVector,modelStruct} from '../../src/discord/model/user.ts';
import {parseSerdeField,parseSerdeStruct,type StructFieldDecoder,type StructShape} from '../../src/core/serde-struct-json.ts';
const base={id:'1',username:'bot',discriminator:'0'};
test('minimal User map gets source Option defaults and bot=false, without requiring absent optional fields',()=>{
 const user=decodeDiscordUser(JSON.stringify(base));assert.equal(Object.getPrototypeOf(user),null);assert.equal(user.id,1n);assert.equal(user.discriminator,0n);assert.equal(user.bot,false);for(const field of ['avatar','primary_guild','email','verified','avatar_decoration_data'])assert.equal(user[field],null);
});
test('snowflake retains full nonzero u64 and accepts Rust unsigned decimal string forms only',()=>{
 assert.equal(parseSerdeField('18446744073709551615',modelSnowflake),18446744073709551615n);assert.equal(parseSerdeField('"+0001"',modelSnowflake),1n);for(const raw of ['0','"0"','-1','1.0','1e0','"1 "','"18446744073709551616"','true'])assert.throws(()=>parseSerdeField(raw,modelSnowflake),SyntaxError,raw);
});
test('discriminator u16 accepts zero/string/integer, never a float or excess value',()=>{
 assert.equal(decodeDiscordUser(JSON.stringify({...base,discriminator:'+65535'})).discriminator,65535n);for(const raw of ['65536','-1','1.0','"1 "','null'])assert.throws(()=>decodeDiscordUser(`{"id":"1","username":"bot","discriminator":${raw}}`),SyntaxError);
});
test('image hashes preserve lowercase hex, animated form and inherited Clyde-prefix exception',()=>{
 for(const hash of ['a_'+'1'.repeat(32),'0'.repeat(32)])assert.equal(parseSerdeField(JSON.stringify(hash),modelImageHash),hash);for(const hash of ['clyde','clyde-any-suffix','clyde🔥','a_'+Buffer.concat([Buffer.from('clyde'),Buffer.alloc(11)]).reverse().toString('hex')])assert.equal(parseSerdeField(JSON.stringify(hash),modelImageHash),'clyde');for(const hash of ['A'.repeat(32),'a_'+'0'.repeat(31),'Clyde','0'.repeat(32)+'\n'])assert.throws(()=>parseSerdeField(JSON.stringify(hash),modelImageHash),SyntaxError);
});
test('nested avatar and primary guild validate their actual fields without invented tag length rules',()=>{
 const user=decodeDiscordUser(JSON.stringify({...base,avatar_decoration_data:{asset:'0'.repeat(32),sku_id:'9'},primary_guild:{identity_guild_id:'8',identity_enabled:true,tag:'x',badge:'clyde'}}));assert.equal((user.avatar_decoration_data as Record<string,unknown>).sku_id,9n);assert.equal((user.primary_guild as Record<string,unknown>).tag,'x');assert.throws(()=>decodeDiscordUser(JSON.stringify({...base,avatar_decoration_data:{asset:'bad',sku_id:'9'}})),SyntaxError);assert.throws(()=>decodeDiscordUser(JSON.stringify({...base,primary_guild:{identity_guild_id:'0'}})),SyntaxError);
});
test('flags truncate unknown bits while unknown u8 premium variants remain accepted',()=>{
 const user=decodeDiscordUser('{"id":"1","username":"b","discriminator":"0","flags":18446744073709551615,"premium_type":255}');const mask=[0,1,2,3,6,7,8,9,10,14,16,17,18,19,22].reduce((v,b)=>v|(1n<<BigInt(b)),0n);assert.equal(user.flags,mask);assert.equal(user.premium_type,255n);for(const value of ['256','-1','1.0'])assert.throws(()=>decodeDiscordUser(`{"id":"1","username":"b","discriminator":"0","premium_type":${value}}`),SyntaxError);
});
test('duplicate recognized fields fail but typed ignored values do not acquire Value parsing rules',()=>{
 assert.throws(()=>decodeDiscordUser('{"id":"1","id":"2","username":"b","discriminator":"0"}'),SyntaxError);assert.equal(decodeDiscordUser('{"id":"1","username":"b","discriminator":"0","future":1e400,"future":"\\ud800"}').id,1n);assert.throws(()=>decodeDiscordUser('{"id":"1","username":"\\ud800","discriminator":"0"}'),SyntaxError);
});
test('User sequence requires all Option positions; map omission and seq omission are distinct',()=>{
 const values=[null,null,null,null,null,false,'0',null,null,null,'1',null,null,'bot',null,null,null,null,null];assert.equal(decodeDiscordUser(JSON.stringify(values)).id,1n);assert.throws(()=>decodeDiscordUser(JSON.stringify(values.slice(0,-1))),SyntaxError);assert.throws(()=>decodeDiscordUser(JSON.stringify([...values,null])),SyntaxError);
});
test('explicit serde defaults still apply to sequences while map-only Option defaults do not',()=>{
 const shape:StructShape={fields:[['optional',modelOption('bool')],['defaulted','bool']],mapDefaults:{optional:null},defaults:{defaulted:false}};assert.deepEqual({...parseSerdeStruct('{}',shape)},{optional:null,defaulted:false});assert.throws(()=>parseSerdeStruct('[]',shape),SyntaxError);assert.deepEqual({...parseSerdeStruct('[null]',shape)},{optional:null,defaulted:false});
});
test('nested typed vector keeps duplicate checks and inherited recursion budget',()=>{
 assert.equal((parseSerdeField('[{"id":"1","username":"b","discriminator":"0"}]',modelVector(discordUserField)) as Record<string,unknown>[])[0]!.id,1n);assert.throws(()=>parseSerdeField('[{"id":"1","id":"2","username":"b","discriminator":"0"}]',modelVector(discordUserField)),SyntaxError);
 const tree:StructShape={fields:[]};const field:StructFieldDecoder=(raw,depth,context)=>context.struct(tree);(tree as {fields:readonly (readonly [string,StructFieldDecoder])[]}).fields=[['next',modelOption(field)]];const nested=(depth:number)=>'{"next":'.repeat(depth)+'null'+'}'.repeat(depth);assert.doesNotThrow(()=>parseSerdeField(nested(127),field));assert.throws(()=>parseSerdeField(nested(128),field),/recursion/);
});
test('booleans and u32 optional fields retain type/range checks',()=>{
 for(const extra of [{bot:null},{verified:1},{accent_color:4294967296},{mfa_enabled:'false'},{avatar_decoration_data:{sku_id:'1'}}])assert.throws(()=>decodeDiscordUser(JSON.stringify({...base,...extra})),SyntaxError);assert.equal(decodeDiscordUser(JSON.stringify({...base,accent_color:4294967295,verified:false})).accent_color,4294967295n);
});

test('published User schema cannot be changed after module initialization',()=>{
 assert.equal(Object.isFrozen(discordUserShape),true);assert.equal(Object.isFrozen(discordUserShape.fields),true);assert.equal(Object.isFrozen(discordUserShape.fields[0]),true);assert.equal(Object.isFrozen(discordUserShape.defaults),true);assert.equal(Object.isFrozen(discordUserShape.mapDefaults),true);
});
