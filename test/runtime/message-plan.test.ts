import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planMessage as plan,MessagePlanError,type IncomingMessage} from '../../src/runtime/message-plan.ts';
const input=(content:string,extra:Partial<IncomingMessage>={}):IncomingMessage=>({content,messageContentEnabled:true,channelAllowed:true,userAllowed:true,authorIsBot:false,authorIsSelf:false,authorMentionsBridge:false,hasAttachments:false,mirroredTarget:false,mentionedUserIds:[],requiredPlainAskUserIds:[],...extra});
const ask=(prompt:string)=>({Execute:{Ask:{prompt}}});
test('policy gates preserve exact source order and reject before parsing commands',()=>{
 const all={messageContentEnabled:false,channelAllowed:false,userAllowed:false,authorIsSelf:true,authorIsBot:true};
 assert.deepEqual(plan(input('!unknown',all)),{Ignore:'message_content_disabled'});
 assert.deepEqual(plan(input('!unknown',{...all,messageContentEnabled:true})),{Ignore:'channel_not_allowed'});
 assert.deepEqual(plan(input('!unknown',{...all,messageContentEnabled:true,channelAllowed:true})),{Ignore:'user_not_allowed'});
 assert.deepEqual(plan(input('!unknown',{authorIsBot:true,authorIsSelf:true})),{Ignore:'self_authored'});
 assert.deepEqual(plan(input('!unknown',{authorIsBot:true})),{Ignore:'bot_author_without_bridge_mention'});
 assert.deepEqual(plan(input('!help',{authorIsBot:true,authorMentionsBridge:true})),{Execute:'Help'});
});
test('bot emergency and valid discard requests require a human even with bridge mention',()=>{
 const bot={authorIsBot:true,authorMentionsBridge:true};
 for(const s of ['!force_restart','!restart_codex force','!recover t','!복구','!repair','!도구복구 t'])assert.deepEqual(plan(input(s,bot)),{Ignore:'force_restart_requires_human'});
 const id='550e8400-e29b-41d4-a716-446655440000';assert.deepEqual(plan(input('!discard-request '+id,bot)),{Ignore:'discard_request_requires_human'});
 assert.deepEqual(plan(input('!discard-request '+id)),{Execute:{DiscardRequest:{job_id:id}}});
 assert.throws(()=>plan(input('!DISCARD-REQUEST '+id,bot)),(e:unknown)=>e instanceof MessagePlanError&&e.kind==='Prefix');
 assert.deepEqual(plan(input('!restart_codex',bot)),{Execute:'RestartCodex'});
});
test('prefix conversion preserves source defaults and special command translations',()=>{
 for(const [raw,action] of [['!list',{List:{limit:10n}}],[' !list 99 ',{List:{limit:30n}}],['!discover_codex','Doctor'],['!mirror',{BridgeSync:{limit:null}}],['!mirror list 3',{MirrorInspect:{limit:3n,list:true}}],['!mirror check',{MirrorInspect:{limit:null,list:false}}],['!pro inspect',{Ask:{prompt:'!pro inspect'}}],['!archive-used 3M',{Ask:{prompt:'Use $archive-used with this threshold:\n\n3M'}}],['!deep-interview inspect',{Interview:{prompt:'inspect'}}],['!settings t --model',{SettingsOptions:{reference:'t',field:'model'}}],['!new',{New:{prompt:''}}],['!restart_codex','RestartCodex']] as const)assert.deepEqual(plan(input(raw)),{Execute:action});
});
test('unsupported detail and malformed prefix keep distinct error boundaries',()=>{
 assert.throws(()=>plan(input('!detail')),(e:unknown)=>e instanceof MessagePlanError&&e.kind==='UnsupportedPrefix'&&e.message==='prefix command is parsed but not implemented yet: !detail');
 assert.throws(()=>plan(input('!unknown')),(e:unknown)=>e instanceof MessagePlanError&&e.kind==='Prefix'&&e.message==='unknown prefix command: !unknown');
 assert.deepEqual(plan(input('plain unknown')),ask('plain unknown'));
});
test('plain ask requires decoded mention membership rather than raw text resemblance',()=>{
 const required={requiredPlainAskUserIds:[42n]};
 assert.deepEqual(plan(input('please continue',required)),{Ignore:'required_mention_missing'});
 assert.deepEqual(plan(input('<@42> please continue',required)),{Ignore:'required_mention_missing'});
 assert.deepEqual(plan(input('<@42> please continue',{...required,mentionedUserIds:[42n]})),ask('please continue'));
 assert.deepEqual(plan(input('text without mention literal',{...required,mentionedUserIds:[42n]})),ask('text without mention literal'));
});
test('set semantics strip all configured mention spellings, preserve unrelated mentions and internal spaces',()=>{
 const options={requiredPlainAskUserIds:[42n,7n,42n],mentionedUserIds:[7n,7n]};
 assert.deepEqual(plan(input('<@42> hi <@!7> <@99> there',options)),ask('hi  <@99> there'));
 assert.deepEqual(plan(input('<@42> <@!7>',options)),{Respond:'Add a prompt after the mention.'});
 assert.deepEqual(plan(input('<@42>',{...options,hasAttachments:true})),ask('Please inspect the attached Discord file(s).'));
});
test('mirrored plain ask bypasses direct mention requirements without stripping content',()=>{
 assert.deepEqual(plan(input('<@42> continue',{mirroredTarget:true,requiredPlainAskUserIds:[42n]})),ask('<@42> continue'));
 assert.deepEqual(plan(input('!help',{requiredPlainAskUserIds:[42n]})),{Execute:'Help'});
});
test('empty text, attachment fallback and Rust whitespace are distinct',()=>{
 assert.deepEqual(plan(input(' \u0085')),{Ignore:'empty_content'});assert.deepEqual(plan(input('',{hasAttachments:true})),ask('Please inspect the attached Discord file(s).'));
 assert.deepEqual(plan(input('\ufeff')),ask('\ufeff'));assert.deepEqual(plan(input('\u0085!help\u0085')),{Execute:'Help'});
});
test('input arrays use lossless u64 identities and do not mutate caller sets',()=>{
 const high=(1n<<64n)-1n,ids=[high,42n,42n],raw=input(`<@${high}> hi`,{requiredPlainAskUserIds:ids,mentionedUserIds:[high]});assert.deepEqual(plan(raw),ask('hi'));assert.deepEqual(ids,[high,42n,42n]);
 for(const bad of [-1n,1n<<64n,1,NaN])assert.throws(()=>plan(input('hi',{mentionedUserIds:[bad as bigint]})),TypeError);
});
test('passive boundary rejects proxies, inherited/getter fields and malformed data without hooks',()=>{
 let hooks=0;const raw=input('hi');Object.defineProperty(raw,'content',{get(){hooks++;return 'hi';}});assert.throws(()=>plan(raw),TypeError);
 const proxy=new Proxy(input('hi'),{get(){hooks++;throw Error('hook');},getOwnPropertyDescriptor(){hooks++;throw Error('hook');}});assert.throws(()=>plan(proxy),TypeError);
 const ids:any[]=[];Object.defineProperty(ids,'0',{get(){hooks++;return 1n;}});assert.throws(()=>plan(input('hi',{mentionedUserIds:ids})),TypeError);
 assert.throws(()=>plan(Object.create(input('hi'))),TypeError);assert.throws(()=>plan(input('\ud800')),TypeError);assert.throws(()=>plan(input('hi',{userAllowed:1 as any})),TypeError);assert.equal(hooks,0);
});
test('plans and converted nested command objects are immutable',()=>{
 for(const s of ['plain','!list','!pro inspect','!mirror list']){const result=plan(input(s));assert.ok(Object.isFrozen(result));assert.ok('Execute'in result);assert.ok(Object.isFrozen(result.Execute));if(typeof result.Execute==='object')for(const value of Object.values(result.Execute))assert.ok(Object.isFrozen(value));}
});
