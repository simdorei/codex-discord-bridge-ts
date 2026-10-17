import test from 'node:test';import assert from 'node:assert/strict';
import {PRO_SKILL_CALL as CALL,rewriteProPrompt,isProCommand,isProSkillPrompt,proConversationScope,formatLocalDevicePrompt,buildProTurnInput} from '../../src/pro/prompt.ts';
import {appBackendTurnInput} from '../../src/runtime/app-server-turn-backend.ts';
test('source review grammar retains review whitespace and trims only ordinary request tail',()=>{
 assert.equal(rewriteProPrompt('  !PRO   review   abc  '),CALL+' <pro-review>\nabc  ');
 assert.equal(rewriteProPrompt('!pro inspect  '),CALL+' inspect');assert.equal(rewriteProPrompt('!pro'),CALL);assert.equal(rewriteProPrompt('!pro review   '),CALL+' <pro-review>');
 for(const p of ['!profile inspect','$custom inspect','plain text','', '\uFEFF!pro']){assert.equal(rewriteProPrompt(p),null);assert.equal(isProCommand(p),false);}
 for(const p of ['\u0085!pRo\u2028inspect','!PRO\tinspect'])assert.equal(rewriteProPrompt(p),CALL+' inspect');
});
test('exact skill boundary distinguishes Rust whitespace from BOM and lookalike suffix',()=>{
 for(const tail of ['',' ','\u0085x','\u2028x'])assert.equal(isProSkillPrompt(CALL+tail),true);
 for(const p of [' '+CALL,CALL+'x',CALL+'\uFEFFx','$ask-chatgpt-probe'])assert.equal(isProSkillPrompt(p),false);
});
test('source conversation scope golden binds exact original thread bytes',()=>{
 assert.equal(proConversationScope('thread-1'),'codex-pro-4b0a5fefc328e6b9257bc535');assert.notEqual(proConversationScope('thread-1'),proConversationScope('thread-2'));assert.notEqual(proConversationScope('thread-1'),proConversationScope(' thread-1'));
});
test('source local-device ticket exact output is data only and escapes attribute delimiters',()=>{
 const result=formatLocalDevicePrompt(rewriteProPrompt('!pro review this project')!,'thread-1',{deviceId:'device&1',workingDirectory:'C:\\repo'});
 assert.equal(result,CALL+' <pro-review>\nthis project\n<local-device-mcp connector="Simdorei Local Project Oauth" resource="https://simdorei.duckdns.org/mcp" device_id="device&amp;1" working_directory="C:\\repo" conversation_scope="codex-pro-4b0a5fefc328e6b9257bc535">\nUse only the connector named in this tag and select it explicitly.\nUse PC mode by default.\nCall list_devices, verify that device_id is online, then call select_device\nexactly once with the device_id, working_directory, and connector resource\nfrom this tag. The working directory identifies the project for this ticket.\nRead a file before updating it and pass its SHA-256 when writing an existing file.\n</local-device-mcp>');
 assert.ok(formatLocalDevicePrompt('raw','t',{deviceId:'<&>"',workingDirectory:'/a&<b>"'}).includes('device_id="&lt;&amp;&gt;&quot;" working_directory="/a&amp;&lt;b&gt;&quot;"'));
});
test('shared backend input builder preserves exact skill and mention DTOs and freezes output',()=>{
 const prompt=CALL+' review this patch',path='C:/plugin/skills/ask-chatgpt-pro/SKILL.md';
 const expected=[{type:'text',text:prompt,text_elements:[]},{type:'skill',name:'ask-chatgpt-pro',path},{type:'mention',name:'Chrome',path:'plugin://chrome@openai-bundled'}];
 assert.deepEqual(buildProTurnInput(prompt,path),expected);assert.deepEqual(appBackendTurnInput(prompt,path),expected);assert.ok(Object.isFrozen(buildProTurnInput(prompt,path)[0]));
 assert.deepEqual(buildProTurnInput('plain',path),[{type:'text',text:'plain',text_elements:[]}]);
});
test('invalid Unicode and active ticket fields reject without invoking hooks',()=>{
 for(const f of [rewriteProPrompt,isProCommand,isProSkillPrompt,proConversationScope])assert.throws(()=>f('\ud800'),TypeError);
 let reads=0;assert.throws(()=>formatLocalDevicePrompt('x','t',{get deviceId(){reads++;return 'x';},workingDirectory:'/tmp'}),TypeError);assert.equal(reads,0);
});
