import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,symlinkSync,readFileSync,existsSync} from 'node:fs';import {dirname} from 'node:path';
import {storeFixture} from '../helpers/store-fixture.ts';import {downloadAttachment} from '../../src/runtime/attachment-download.ts';
import {enrichMessageAttachments} from '../../src/runtime/attachments.ts';import {decodeGatewayMessage} from '../../src/discord/gateway/decoded-message.ts';
const input={filename:'a.txt',size:3n,url:'https://example.invalid/fixture',contentType:'text/plain'};
function paths(p:string){const root=dirname(p);mkdirSync(root+'/physical/child',{recursive:true});symlinkSync(root+'/physical/child',root+'/alias','dir');return{root,physical:root+'/physical',raw:root+'/alias/..'};}
function transport(before=()=>{}){let releases=0;return {get releases(){return releases;},async get(){before();return {contentLength:3n,chunks:(async function*(){yield Buffer.from('abc');})(),async release(){releases++;}};}};}
test('download writes and previews the native symlink-parent destination',()=>storeFixture(async p=>{const f=paths(p),t=transport();const result=await downloadAttachment(1n,input,f.raw,10n,10n,t,true);assert.equal(readFileSync(f.physical+'/01-a.txt','utf8'),'abc');assert.equal(existsSync(f.root+'/01-a.txt'),false);assert.deepEqual(result.preview,['a.txt','abc']);assert.equal(t.releases,1);}));
test('attachment envelope creates numeric child directories under the native root',()=>storeFixture(async p=>{
 const f=paths(p),t=transport();const m=decodeGatewayMessage(JSON.stringify({attachments:[{id:'10',filename:'a.txt',size:3,url:input.url,proxy_url:input.url,content_type:'text/plain'}],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content:'ask',edited_timestamp:null,embeds:[],id:'3',mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-02-02T02:02:02.020000+00:00',tts:false,type:0}));
 await enrichMessageAttachments(m,'ask',{attachmentsEnabled:true,attachmentMaxBytes:10n,attachmentTextInlineMaxBytes:10n},f.raw,t,true,()=>assert.fail());
 assert.equal(readFileSync(f.physical+'/1/3/01-a.txt','utf8'),'abc');assert.equal(existsSync(f.root+'/1'),false);assert.equal(t.releases,1);
}));
test('download captures relative destination before invoking asynchronous transport',()=>storeFixture(async p=>{
 const f=paths(p),cwd=process.cwd();mkdirSync(f.root+'/downloads');mkdirSync(f.physical+'/downloads');
 try{process.chdir(f.root);const t=transport(()=>process.chdir(f.physical));await downloadAttachment(1n,input,'downloads',10n,10n,t,true);assert.equal(readFileSync(f.root+'/downloads/01-a.txt','utf8'),'abc');assert.equal(existsSync(f.physical+'/downloads/01-a.txt'),false);assert.equal(t.releases,1);}finally{process.chdir(cwd);}
}));
