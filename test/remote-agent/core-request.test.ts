import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseCoreRequest} from '../../src/remote-agent/core-request.ts';
import {RemoteProtocolError} from '../../src/remote-agent/handshake.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const budget=12000000,sha='a'.repeat(64),parse=(v:unknown)=>parseCoreRequest(serializeSerdeValue(v),budget);
const fails=(v:unknown,kind:'Json'|'Validation',field?:string)=>assert.throws(()=>parse(v),(e:unknown)=>e instanceof RemoteProtocolError&&e.kind===kind&&(field===undefined||e.message.includes(field+':')));
const change={action:'create',path:'a',content:''};const patch=(changes:unknown)=>({kind:'file_apply_patch',changes});
test('all eighteen core request variants decode defaults and immutable data',()=>{
 for(const kind of ['project_rules','project_status','command_list','repo_status','repo_diff','list_images','checkpoint_list'])assert.deepEqual(parse({kind}),{kind});
 assert.deepEqual(parse({kind:'code_search',query:'x'}),{kind:'code_search',query:'x',max_results:100n});
 assert.deepEqual(parse({kind:'file_create',path:'a',content:''}),{kind:'file_create',path:'a',content:'',overwrite:false});
 assert.deepEqual(parse({kind:'command_run',command_id:'x'}),{kind:'command_run',command_id:'x',timeout_seconds:60n});
 const p=parse(patch([change]));if(p.kind!=='file_apply_patch')throw Error('variant');assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.changes)&&Object.isFrozen(p.changes[0]));assert.deepEqual(p.changes[0],{...change,destination:null,expected_sha256:null});
 const c=parse({kind:'git_commit',message:'x',paths:['']});if(c.kind!=='git_commit')throw Error('variant');assert.ok(Object.isFrozen(c.paths));
 assert.deepEqual(parse({kind:'git_push'}),{kind:'git_push',remote:'origin',branch:null});
 assert.equal(parse({kind:'save_image',path:'x',data_base64:'!!!!'}).kind,'save_image');
 assert.equal(parse({kind:'save_image_from_url',path:'x',url:'https://example.com/x'}).kind,'save_image_from_url');
 assert.equal(parse({kind:'retrieve_image',path:'x'}).kind,'retrieve_image');
 for(const kind of ['checkpoint_show','checkpoint_restore'])assert.equal(parse({kind,checkpoint_id:'cp_0123456789abcdef'}).kind,kind);
});
test('core missing, null, wrong numeric and unknown fields never silently default',()=>{
 for(const v of [{kind:'code_search',query:'x',max_results:null},{kind:'code_search',query:'x',max_results:65536n},{kind:'command_run',command_id:'x',timeout_seconds:-1n},{kind:'file_create',path:'x',content:'',overwrite:null},{kind:'git_push',remote:null},{kind:'repo_status',extra:1n},{kind:'git_commit',message:'x',paths:[1n]},{kind:'file_create',path:'x'},{kind:'file_apply_patch',changes:null}])fails(v,'Json');
 for(const token of ['1.0','1e0','-0'])assert.throws(()=>parseCoreRequest(`{"kind":"code_search","query":"x","max_results":${token}}`,budget),(e:unknown)=>e instanceof RemoteProtocolError&&e.kind==='Json');
 fails(patch([{...change,kind:'anything'}]),'Json');fails(patch([{...change,unexpected:null}]),'Json');fails(patch([{...change,content:1n}]),'Json');
 // Full decoding precedes semantic validation even when the first record's path is invalid.
 fails(patch([{...change,path:''},{...change,action:'bad'}]),'Json');
});
test('core semantic bounds use Unicode scalars and exact unsigned limits',()=>{
 assert.equal(parse({kind:'code_search',query:'😀'.repeat(500),max_results:200n}).kind,'code_search');
 fails({kind:'code_search',query:'😀'.repeat(501)},'Validation','query');
 for(const max_results of [0n,201n,65535n])fails({kind:'code_search',query:'x',max_results},'Validation','max_results');
 assert.equal(parse({kind:'command_run',command_id:'😀'.repeat(300),timeout_seconds:300n}).kind,'command_run');
 fails({kind:'command_run',command_id:'x',timeout_seconds:301n},'Validation','timeout_seconds');
 assert.equal(parse({kind:'file_create',path:'😀'.repeat(1000),content:'😀'.repeat(1048576)}).kind,'file_create');
 fails({kind:'file_create',path:'x',content:'x'.repeat(1048577)},'Validation','content');
 fails({kind:'retrieve_image',path:''},'Validation','path');
});
test('file change action constraints retain source error precedence and move content allowance',()=>{
 assert.equal(parse(patch([{action:'update',path:'x',content:'',expected_sha256:sha},{action:'delete',path:'x',expected_sha256:sha},{action:'move',path:'x',destination:'y',content:'optional',expected_sha256:sha}])).kind,'file_apply_patch');
 for(const c of [{action:'create',path:'x'},{action:'update',path:'x'}])fails(patch([c]),'Validation','content');
 for(const c of [{action:'update',path:'x',content:''},{action:'delete',path:'x',content:'x'},{action:'move',path:'x'}])fails(patch([c]),'Validation','expected_sha256');
 fails(patch([{action:'move',path:'x',expected_sha256:sha}]),'Validation','destination');
 fails(patch([{...change,expected_sha256:sha}]),'Validation','expected_sha256');
 fails(patch([{action:'delete',path:'x',expected_sha256:sha,content:''}]),'Validation','content');
 fails(patch([{...change,destination:'y'}]),'Validation','destination');
 for(const expected_sha256 of ['A'.repeat(64),'a'.repeat(63),sha+'\n'])fails(patch([{action:'delete',path:'x',expected_sha256}]),'Validation','expected_sha256');
 fails(patch([]),'Validation','changes');fails(patch(Array.from({length:201},()=>change)),'Validation','changes');
 assert.equal(parse(patch(Array.from({length:200},()=>change))).kind,'file_apply_patch');
});
test('file patch combined cap is ten MiB of UTF8 bytes, not per-file scalar counts',()=>{
 const content='😀'.repeat(262144),ten=Array.from({length:10},(_,i)=>({...change,path:String(i),content}));
 assert.equal(Buffer.byteLength(content),1048576);assert.equal(parse(patch(ten)).kind,'file_apply_patch');
 fails(patch([...ten,{...change,content:'x'}]),'Validation','changes');
});
test('Git names and checkpoint identifiers reject trailing newlines but keep source permissive paths',()=>{
 assert.equal(parse({kind:'git_commit',message:'x',paths:['','\0','../outside','😀']}).kind,'git_commit');
 fails({kind:'git_commit',message:'',paths:['x']},'Validation','message');fails({kind:'git_commit',message:'x',paths:[]},'Validation','paths');
 for(const remote of ['', 'origin\n','x/y','원격'])fails({kind:'git_push',remote},'Validation','remote');
 for(const branch of ['', '-x','a\n','😀'])fails({kind:'git_push',branch},'Validation','branch');
 for(const branch of [null,'main','a/b','a..b'])assert.equal(parse({kind:'git_push',branch}).kind,'git_push');
 for(const checkpoint_id of ['cp_0123456789abcdef\n','cp_0123456789ABCDEF','cp_0123456789abcde'])fails({kind:'checkpoint_show',checkpoint_id},'Validation','checkpoint_id');
});
test('image contract validates strings and HTTP URL without doing network or base64 decode',()=>{
 fails({kind:'save_image',path:'x',data_base64:'abc'},'Validation','data_base64');
 assert.equal(parse({kind:'save_image',path:'x',data_base64:'!!!!',overwrite:true}).kind,'save_image');
 for(const url of ['https://example.com/a','http://127.0.0.1:123/a','https://사용자:암호@example.com/경로'])assert.equal(parse({kind:'save_image_from_url',path:'x',url}).kind,'save_image_from_url');
 for(const url of ['not a URL','file:///tmp/a','ftp://example.com/a','https://'])fails({kind:'save_image_from_url',path:'x',url},'Validation','url');
});
test('core frame ownership rejects malformed and over-budget data and accepts exact duplicate-key semantics',()=>{
 const raw='{"kind":"retrieve_image","path":"😀"}',size=Buffer.byteLength(raw);assert.equal(parseCoreRequest(raw,size).kind,'retrieve_image');assert.throws(()=>parseCoreRequest(raw,size-1),RangeError);
 for(const raw of ['null','[]','{}','{"kind":"project_rules"} x','{"kind":"retrieve_image","path":"\\ud800"}'])assert.throws(()=>parseCoreRequest(raw,budget),(e:unknown)=>e instanceof RemoteProtocolError&&e.kind==='Json');
 assert.deepEqual(parseCoreRequest('{"kind":"bad","kind":"repo_status"}',budget),{kind:'repo_status'});
});
