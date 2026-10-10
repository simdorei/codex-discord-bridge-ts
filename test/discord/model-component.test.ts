import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeDiscordComponent as component,discordEmojiField,discordUnfurledMediaField,discordMediaGalleryItemField} from '../../src/discord/model/component.ts';
import {parseSerdeField,type StructFieldDecoder} from '../../src/core/serde-struct-json.ts';
const decode=(value:unknown)=>component(JSON.stringify(value));
const child={type:10,content:'x'};

test('component visitor accepts only maps and requires an unsigned byte type',()=>{
 for(const raw of ['[]','[1,[]]','null','"button"','{}','{"type":null}','{"type":256}','{"type":-1}','{"type":1.0}'])assert.throws(()=>component(raw),SyntaxError,raw);
 for(const type of [0,15,16,20,255])assert.deepEqual({...decode({type})},{type:BigInt(type)});
});
test('all source component variants enforce their individual minimal fields',()=>{
 const cases=[{type:1,components:[]},{type:2,style:1},{type:3,custom_id:'',options:[]},{type:4,custom_id:'',style:1},...[5,6,7,8].map(type=>({type,custom_id:''})),{type:9,components:[],accessory:child},{type:10,content:''},{type:11,media:{url:''}},{type:12,items:[]},{type:13,file:{url:''}},{type:14},{type:17,components:[]},{type:18,label:'',component:child},{type:19,custom_id:''}];
 for(const value of cases)assert.equal(decode(value).type,BigInt(value.type));
 for(const value of [{type:1},{type:2},{type:3,custom_id:''},{type:3,options:[]},{type:4,style:1},{type:4,custom_id:''},{type:9,components:[]},{type:9,accessory:child},{type:10},{type:11},{type:12},{type:13},{type:17},{type:18,label:''},{type:18,component:child},{type:19}])assert.throws(()=>decode(value),SyntaxError,JSON.stringify(value));
});
test('request validation rules are not invented by the response model',()=>{
 assert.equal(decode({type:2,style:5}).url,null);assert.equal(decode({type:2,style:6,label:'premium label without sku'}).sku_id,null);assert.equal(decode({type:2,style:255}).style,255n);assert.deepEqual(decode({type:1,components:[{type:1,components:[]}]}).components,[decode({type:1,components:[]})]);assert.doesNotThrow(()=>decode({type:12,items:Array.from({length:11},()=>({media:{url:'not-a-url'}}))}));
});
test('all recognized fields are validated even for unknown component kinds',()=>{
 for(const [key,value] of Object.entries({channel_types:null,components:null,default_values:{},disabled:null,emoji:{},label:1,max_length:65536,max_values:256,min_length:-1,min_values:-1,options:null,placeholder:1,required:0,type:256,url:1,sku_id:'0',value:1,id:null,content:null,items:null,divider:null,spacing:null,file:{},spoiler:null,accessory:null,media:{},description:1,accent_color:4294967296,component:null}))assert.throws(()=>decode({type:255,[key]:value}),SyntaxError,key);
 assert.doesNotThrow(()=>decode({type:255,style:{arbitrary:true},custom_id:[1,2],spacing:255,id:-2147483648}));
 assert.throws(()=>decode({type:255,id:2147483648}),SyntaxError);
});
test('source nullable slots distinguish repeatable null from occupied duplicate values',()=>{
 assert.equal(component('{"type":2,"style":1,"sku_id":null,"sku_id":null,"sku_id":"1"}').sku_id,1n);
 assert.deepEqual(component('{"type":5,"custom_id":"x","default_values":null,"default_values":null,"default_values":[]}').default_values,[]);
 for(const raw of ['{"type":2,"style":1,"sku_id":"1","sku_id":null}','{"type":5,"custom_id":"x","default_values":[],"default_values":null}','{"type":255,"label":null,"label":null}','{"type":255,"custom_id":null,"custom_id":null}','{"type":255,"style":null,"style":null}','{"type":255,"emoji":null,"emoji":null}','{"type":255,"type":255}'])assert.throws(()=>component(raw),SyntaxError,raw);
});
test('unused buffered fields accept arbitrary values but still reject invalid full Value content',()=>{
 assert.doesNotThrow(()=>component('{"type":255,"style":{"k":1,"k":2},"custom_id":false}'));
 assert.throws(()=>component('{"type":255,"style":{"k":1e400}}'));
 assert.throws(()=>component('{"type":255,"custom_id":"\\ud800"}'),SyntaxError);
 assert.equal(component('{"type":255,"future":1e400,"future":"\\ud800"}').type,255n);
});
test('selected button/text input styles and custom identities use their own contracts',()=>{
 for(const style of [0,3,255,null,'1',1.5])assert.throws(()=>decode({type:4,custom_id:'x',style}),SyntaxError);
 for(const style of [1,2])assert.equal(decode({type:4,custom_id:'',style}).style,BigInt(style));
 for(const type of [3,4,5,6,7,8,19])for(const custom_id of [null,1,{},[]])assert.throws(()=>decode({type,custom_id,style:1,options:[]}),SyntaxError);
 assert.equal(decode({type:2,style:1,custom_id:null}).custom_id,null);assert.throws(()=>decode({type:2,style:1,custom_id:1}),SyntaxError);
});
test('component fields preserve defaults rather than substituting documented UI defaults',()=>{
 const separator=decode({type:14});assert.equal(separator.divider,null);assert.equal(separator.spacing,null);
 assert.equal(decode({type:4,custom_id:'x',style:1}).required,null);assert.equal(decode({type:2,style:1}).disabled,false);assert.equal(decode({type:5,custom_id:'x'}).disabled,false);
});
test('select menus preserve u8 channel kinds and validate complete options',()=>{
 const menu=decode({type:8,custom_id:'x',channel_types:[0,255],options:[{label:'',value:'',emoji:{name:'😀'}}],max_values:255,min_values:0,required:false});
 assert.deepEqual(menu.channel_types,[0n,255n]);assert.equal((menu.options as Record<string,unknown>[])[0]!.default,false);
 for(const options of [[{label:'x'}],[{value:'x'}],[{label:'x',value:'y',default:null}],[{label:'x',value:'y',emoji:{id:'1',name:1}}]])assert.throws(()=>decode({type:5,custom_id:'x',options}),SyntaxError);
});
test('adjacent select defaults accept either order and complete sequences but reject unknown tags and duplicates',()=>{
 const raw='{"type":5,"custom_id":"x","default_values":[{"type":"user","id":"1"},{"id":2,"type":"role"},["channel","3"],{"type":{"user":null},"id":"4","future":1e400}]}';
 const values=component(raw).default_values as Record<string,unknown>[];assert.deepEqual(values.map(v=>[v.type,v.id]),[['user',1n],['role',2n],['channel',3n],['user',4n]]);
 for(const entry of ['{"type":"guild","id":"1"}','{"type":"user","id":null}','{"type":"user","type":"role","id":"1"}','{"type":"user","id":"1","id":"2"}','["user"]','["user","1",0]','{"type":{"user":null,"user":null},"id":"1"}'])assert.throws(()=>component(`{"type":5,"custom_id":"x","default_values":[${entry}]}`),SyntaxError,entry);
});
test('emoji Content fallback preserves Unicode when Custom cannot deserialize',()=>{
 const emoji=(raw:string)=>parseSerdeField(raw,discordEmojiField) as Record<string,unknown>;
 assert.deepEqual(emoji('{"id":"1"}'),{kind:'Custom',animated:false,id:1n,name:null});
 assert.deepEqual(emoji('{"id":"0","name":"unicode","animated":null}'),{kind:'Unicode',name:'unicode'});
 assert.deepEqual(emoji('{"id":"1","id":"2","name":"unicode"}'),{kind:'Unicode',name:'unicode'});
 assert.deepEqual(emoji('{"id":"1","animated":false,"animated":true,"name":"u"}'),{kind:'Unicode',name:'u'});
 for(const raw of ['[false,"1",null]','{"name":null}','{"name":"x","name":"y"}','{"name":"x","future":1e400}'])assert.throws(()=>emoji(raw));
});
test('gallery and unfurled media decode complete child fields and sequence order',()=>{
 const value=parseSerdeField('{"media":{"url":"attachment://x","height":null,"width":4294967295},"spoiler":false}',discordMediaGalleryItemField) as Record<string,unknown>;
 assert.equal((value.media as Record<string,unknown>).width,4294967295n);assert.equal(value.description,null);assert.equal(value.spoiler,false);
 const media=parseSerdeField('["u",null,null,0,null]',discordUnfurledMediaField) as Record<string,unknown>;assert.equal(media.width,0n);
 for(const raw of ['{}','{"url":"x","height":4294967296}','["u"]'])assert.throws(()=>parseSerdeField(raw,discordUnfurledMediaField),SyntaxError);
});
test('recursive component vectors share the parser recursion budget',()=>{
 let value:unknown={type:255};for(let i=0;i<63;i++)value={type:1,components:[value]};assert.doesNotThrow(()=>decode(value));value={type:1,components:[value]};assert.throws(()=>decode(value),/recursion/);
});
test('custom map callbacks preserve duplicate order and never decode ignored values',()=>{
 const visit:StructFieldDecoder=(_raw,_depth,context)=>{const pairs:unknown[]=[];context.map((key,decode)=>{if(key==='x')pairs.push(decode('u64'));});return pairs;};
 assert.deepEqual(parseSerdeField('{"x":1,"skip":1e400,"x":2,"skip":"\\ud800"}',visit),[1n,2n]);assert.throws(()=>parseSerdeField('[1,2]',visit),SyntaxError);
});
test('projection discards fields unused by the selected variant without skipping their validation',()=>{
 const v=decode({type:10,content:'text',disabled:true,style:{anything:[]},custom_id:12});assert.deepEqual({...v},{type:10n,id:null,content:'text'});
 const row=decode({type:1,components:[{type:18,label:'L',component:{type:19,custom_id:'upload',required:true}}]});assert.equal((((row.components as Record<string,unknown>[])[0]!.component) as Record<string,unknown>).required,true);
});
