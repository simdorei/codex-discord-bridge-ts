import test from 'node:test';import assert from 'node:assert/strict';
import {AdminArgs} from '../../src/cli/admin-args.ts';
const parse=(...a:string[])=>AdminArgs.parse(a);
test('all frozen admin identities accept repo root and reject foreign flags',()=>{
 for(const c of ['setup-discord','configure-install','verify-plugin-inventory','discover-codex','backup-store','active-queue-count','retire-automatic-reserve','authorize-saved-final','list-threads','archive-thread','inspect-new-first-reply','recover-writer','recover-tools','inspect-async-recovery','check-recovery-compatibility','send-attachment']){
  assert.equal(parse(c,'--repo-root','repo').root('/cwd','posix'),'/cwd/repo');assert.throws(()=>parse(c,'--foreign'),{message:`unknown option for ${c}: --foreign`});
 }
});
test('command and sequential error ordering matches lazy UTF8 conversion',()=>{
 assert.throws(()=>parse(),{message:'missing admin command'});assert.throws(()=>parse('\ud800'),{message:'admin arguments must be UTF-8'});
 assert.throws(()=>parse('unknown','\ud800'),{message:'unknown admin command: unknown'});
 assert.throws(()=>parse('backup-store','--bad','\ud800'),{message:'unknown option for backup-store: --bad'});
 assert.throws(()=>parse('backup-store','--repo-root','\ud800'),{message:'admin arguments must be UTF-8'});
});
test('values are exact, option-looking values consumed and empty required fails without trimming',()=>{
 const a=parse('configure-install','--codex-home','--codex-exe','--repo-root','');assert.equal(a.required('--codex-home'),'--codex-exe');assert.equal(a.value('--codex-exe'),undefined);assert.equal(a.root('/cwd','posix'),'/cwd/');
 assert.throws(()=>a.required('--repo-root'),{message:'missing required option --repo-root'});assert.throws(()=>a.required('--missing'),{message:'missing required option --missing'});
 assert.equal(parse('configure-install','--codex-home',' ').required('--codex-home'),' ');
 assert.throws(()=>parse('list-threads','--limit'),{message:'missing value after --limit'});
});
test('duplicates including flags fail before missing values or incompatible mode check',()=>{
 for(const flag of ['--dry-run','--input-stdin','--input-lines'])assert.throws(()=>parse('setup-discord',flag,flag),{message:`duplicate admin option: ${flag}`});
 assert.throws(()=>parse('list-threads','--limit','2','--limit'),{message:'duplicate admin option: --limit'});
 for(const pair of [['--dry-run','--input-stdin'],['--input-stdin','--input-lines'],['--dry-run','--input-lines']])assert.throws(()=>parse('setup-discord',...pair),{message:'--dry-run, --input-stdin and --input-lines cannot be combined'});
});
test('boolean modes keep empty option value and exact immutable fields',()=>{
 for(const [flag,field] of [['--dry-run','dryRun'],['--input-stdin','inputStdin'],['--input-lines','inputLines']] as const){const a=parse('setup-discord',flag);assert.equal(a[field],true);assert.equal(a.value(flag),'');assert.ok(Object.isFrozen(a));assert.ok(Object.isFrozen(a.files));}
});
test('attachment positional paths and separator are source compatible',()=>{
 const a=parse('send-attachment','a','--channel-id','42','','--','--content','x','--','-file');assert.deepEqual(a.files,['a','','--content','x','--','-file']);assert.equal(a.value('--channel-id'),'42');assert.equal(a.value('--content'),undefined);
 assert.throws(()=>parse('backup-store','file'),{message:'unknown option for backup-store: file'});
 assert.throws(()=>parse('send-attachment','--','\ud800'),{message:'admin arguments must be UTF-8'});
});
test('root joining preserves symlink parent traversal and absolute override',()=>{
 assert.equal(parse('backup-store','--repo-root','alias/../repo').root('/cwd','posix'),'/cwd/alias/../repo');
 assert.equal(parse('backup-store','--repo-root','/absolute').root('/cwd','posix'),'/absolute');
 assert.equal(parse('backup-store','--repo-root','relative').root('C:\\cwd','win32'),'C:\\cwd\\relative');
});
test('source option families are independently accepted with exact values',()=>{
 const cases:[string,string[]][]=[['verify-plugin-inventory',['--marketplace-inventory','--plugin-inventory','--plugin-manifest','--marketplace-name','--plugin-id']],['discover-codex',['--codex-exe']],['authorize-saved-final',['--request-file']],['archive-thread',['--thread-id']],['inspect-new-first-reply',['--database','--job-id']],['recover-writer',['--thread-id','--channel-id','--owner-user-id']],['recover-tools',['--thread-id','--channel-id','--owner-user-id']],['inspect-async-recovery',['--database','--thread-id']],['check-recovery-compatibility',['--database','--env']],['send-attachment',['--channel-id','--thread-ref','--work-thread','--content','--content-file']]];
 for(const [command,flags] of cases){const a=parse(command,...flags.flatMap(f=>[f,'한글']));for(const flag of flags)assert.equal(a.value(flag),'한글');}
});
