import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sanitizeAttachmentFilename as safe,isTextAttachment as text,renderAttachmentPrompt as render} from '../../src/runtime/attachment-format.ts';
test('Unix source path leaf normalization never treats backslash as separator',()=>{
 for(const [input,expected] of [['/tmp/name.txt','name.txt'],['a//./b.txt/','b.txt'],['a/.','a'],['a/..','attachment-2'],['/','attachment-2'],['.','attachment-2'],['C:\\dir\\name.txt','C__dir_name.txt']])assert.equal(safe(input!,2),expected);
});
test('ASCII-only filename projection counts Unicode scalars then trims exact spaces and dots',()=>{
 assert.equal(safe('한😀글.txt',1),'___.txt');assert.equal(safe(' .. foo... ',1),'foo');assert.equal(safe('a\nb\tc',1),'a_b_c');assert.equal(safe(' . ',0),'attachment-0');assert.equal(safe('x'.repeat(130)+'.txt',1),'x'.repeat(120));assert.equal(safe('....',18446744073709551615n),'attachment-18446744073709551615');
});
test('every source text extension and ASCII text MIME recognized without whitespace broadening',()=>{
 for(const ext of ['bat','cmd','css','csv','html','ini','js','json','log','md','ps1','py','rs','sh','toml','ts','tsx','txt','xml','yaml','yml'])assert.equal(text('name.'+ext.toUpperCase(),null),true);
 assert.equal(text('x.bin','TEXT/plain'),true);for(const filename of ['.txt','a.txt.','a.bin','a/..'])assert.equal(text(filename,null),false);assert.equal(text('..txt',null),true);assert.equal(text('x.bin',' text/plain'),false);assert.equal(text('x.bin','application/json'),false);
});
test('rendering exact labels and source White_Space trim keeps BOM',()=>{
 assert.equal(render('  ask\u0085',['1. x'],[['x','line\nnext']]),'ask\n\nDiscord attachments saved locally:\n1. x\n\nAttachment text previews:\n--- x ---\n```text\nline\nnext\n```');assert.equal(render('\ufeffask\ufeff',['d'],[]),'\ufeffask\ufeff\n\nDiscord attachments saved locally:\nd');
});
test('no saved details preserves base bytes and nonempty details preserve order',()=>{
 assert.equal(render(' \nask \n',[],[]),' \nask \n');assert.equal(render('', ['first','second'],[]),'Discord attachments saved locally:\nfirst\nsecond');
});
test('typed helper boundaries refuse malformed Unicode, nonlossless indices and getters without hooks',()=>{
 for(const v of [-1,1.1,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>safe('x',v));assert.throws(()=>safe('\ud800',1),TypeError);let calls=0;const d:any=[];Object.defineProperty(d,'0',{get(){calls++;return 'x';}});assert.throws(()=>render('x',d,[]),TypeError);assert.equal(calls,0);assert.throws(()=>render('x',['d'],[['x'] as any]),TypeError);
});
