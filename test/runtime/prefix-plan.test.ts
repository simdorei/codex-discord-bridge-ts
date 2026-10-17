import assert from 'node:assert/strict';
import {test} from 'node:test';
import {planPrefix as plan,PrefixPlanError} from '../../src/runtime/prefix-plan.ts';
import {AUTO_RESERVE_REMOVED} from '../../src/discord/interaction-routing.ts';
import {isForceRestartMessage} from '../../src/discord/gateway/routing.ts';
const usage=(s:string,text?:string)=>assert.throws(()=>plan(s),(e:unknown)=>e instanceof PrefixPlanError&&e.kind==='Usage'&&(text===undefined||e.message===text));
const eq=(s:string,v:unknown)=>assert.deepEqual(plan(s),v);
test('source contract help, aliases, required targets and loose optional targets',()=>{
 for(const s of ['','help','START',' help ignored'])eq(s,'Help');
 for(const [s,v] of [['doctor','Doctor'],['whoami','Identity'],['chatid','Identity'],['map','Where'],['where','Where'],['resources','Resources'],['system','Resources'],['approval','Approval'],['approve','Approval'],['discover_codex','DiscoverCodex']] as const)eq(s,v);
 eq('use abc',{Use:{reference:'abc'}});eq('open_abort abc',{Open:{reference:'abc',abort:true}});eq('open abc',{Open:{reference:'abc',abort:false}});
 for(const [s,k] of [['status','Status'],['stop','Stop'],['archive','Archive'],['resume','Resume'],['retract','Retract'],['unqueue','Retract']] as const){eq(s,{[k]:{reference:null}});eq(s+' a b',{[k]:{reference:'a b'}});}
 for(const s of ['use','open','open_abort','delete_archive','confirm_delete_archive'])usage(s);
 eq('delete_archive abc',{DeleteArchivePreview:{reference:'abc'}});eq('confirm_delete_archive abc',{DeleteArchiveConfirm:{reference:'abc'}});
});
test('i64 parsing keeps source defaults, clamping, signs and overflow behavior',()=>{
 eq('list',{List:{limit:0n}});eq('list nope',{List:{limit:10n}});eq('list 999',{List:{limit:30n}});eq('list -1',{List:{limit:1n}});eq('list +2',{List:{limit:2n}});
 for(const s of ['9223372036854775808','-9223372036854775809','1e2','0x10','1_0','--1','+','１２','1 2']){eq('list '+s,{List:{limit:10n}});usage('usage '+s,'Usage: !usage [days]');}
 eq('list 9223372036854775807',{List:{limit:30n}});eq('list -9223372036854775808',{List:{limit:1n}});
 for(const s of ['archived_list','archive_list']){eq(s,{ArchivedList:{limit:10n}});eq(s+' 100',{ArchivedList:{limit:50n}});eq(s+' nonsense',{ArchivedList:{limit:10n}});}
 for(const s of ['usage','quota','limit']){eq(s,{Usage:{days:7n}});eq(s+' 0',{Usage:{days:1n}});eq(s+' 99',{Usage:{days:30n}});}
});
test('restart parsing agrees with existing emergency route and never implicitly forces',()=>{
 eq('restart_codex','RestartCodex');for(const s of ['restart_codex force','restart_codex --force','force_restart','RESTART_CODEX FORCE','\u0085restart_codex\u0085FORCE']){eq(s,'ForceRestartCodex');assert.equal(isForceRestartMessage('!'+s),true);}
 for(const s of ['restart_codex maybe','restart_codex force later','force_restart now']){usage(s,'Usage: !restart_codex [force] or !force_restart');assert.equal(isForceRestartMessage('!'+s),false);}
});
test('recovery aliases permit zero or one reference only',()=>{
 for(const [s,k] of [['recover','Recover'],['복구','Recover'],['repair','Repair'],['도구복구','Repair']] as const){eq(s,{[k]:{reference:null}});eq(s+' t',{[k]:{reference:'t'}});usage(s+' a b');usage(s+' a\u0085b');}
});
test('context refresh and all modes preserve different limits and exact grammar',()=>{
 for(const s of ['context','ctx']){eq(s,{Context:{all_threads:false,refresh:false,limit:10n}});eq(s+' ALL',{Context:{all_threads:true,refresh:false,limit:20n}});eq(s+' *',{Context:{all_threads:true,refresh:false,limit:20n}});}
 for(const s of ['refresh','recent']){eq('ctx '+s,{Context:{all_threads:false,refresh:true,limit:10n}});eq('ctx '+s+' 99',{Context:{all_threads:false,refresh:true,limit:30n}});usage('ctx '+s+' nope','Usage: !context refresh [integer limit]');}
 for(const s of ['context all 2','context unknown','context refresh 2 x'])usage(s,'Usage: !context [all | refresh [limit]]');
});
test('saved request identifiers are one source whitespace token',()=>{
 for(const s of ['runners','queues']){eq(s,'Runners');eq(s+' message:123',{SavedRequest:{request_id:'message:123'}});usage(s+' a b','Usage: !runners [request_id]');}
});
test('discard requires exact lowercase command and canonical lowercase UUID',()=>{
 const id='550e8400-e29b-41d4-a716-446655440000';eq('discard-request '+id,{DiscardRequest:{job_id:id}});eq('\u0085discard-request '+id+'\u0085',{DiscardRequest:{job_id:id}});
 for(const s of ['DISCARD-REQUEST '+id,'discard-request '+id.toUpperCase(),'discard-request '+id.replaceAll('-',''),'discard-request {'+id+'}','discard-request urn:uuid:'+id,'discard-request '+id+' x','discard-request'])usage(s,'Usage: !discard-request <exact canonical job UUID>');
});
test('bridge aliases retain bounded optional integer and ASCII subcommand rules',()=>{
 for(const s of ['bridge_sync','resync','sync','bridge'])eq(s,{BridgeSync:{limit:null}});
 eq('bridge SYNC 999',{BridgeSync:{limit:100n}});eq('resync -10',{BridgeSync:{limit:1n}});
 for(const s of ['bridge other','bridge 10','bridge sync no','sync 1 2'])usage(s,'Usage: !bridge sync [limit]');
});
test('mirror and detail grammar preserves aliases without silently accepting extra words',()=>{
 for(const s of ['mirror','mirror sync','mirror SYNC'])eq(s,'MirrorSync');
 eq('mirror list 7',{MirrorList:{limit:7n}});eq('mirror doctor',{MirrorCheck:{limit:null}});eq('mirror check 101',{MirrorCheck:{limit:100n}});
 for(const s of ['mirror list no','mirror check 1 2'])usage(s);
 for(const s of ['mirror sync 2','mirror bad'])usage(s,'Usage: !mirror sync | !mirror list [limit] | !mirror check [limit]');
 eq('detail',{MirrorDetail:{mode:null}});eq('detail SEND',{MirrorDetail:{mode:'Send'}});eq('detail all',{MirrorDetail:{mode:'All'}});usage('detail verbose');
});
test('prompt, skill, QA and reboot descriptions preserve required arguments',()=>{
 eq('new',{New:{prompt:''}});eq('new a  b',{New:{prompt:'a  b'}});eq('steer p',{Steer:{prompt:'p'}});usage('steer');
 for(const [s,k,n] of [['pro','Pro','request'],['interview','Interview','request'],['deep_interview','Interview','request'],['deep-interview','Interview','request'],['archive-used','ArchiveUsed','threshold']] as const){eq(s+' inspect',{SkillPrompt:{kind:k,request:'inspect'}});usage(s,`Usage: !${s} <${n}>`);}
 for(const s of ['qa','qa button','qa BUTTONS'])eq(s,'QaButtons');usage('qa other','Usage: !qa buttons');
 for(const s of ['reset_pc','reboot_pc','reset_computer']){eq(s+' CONFIRM','HostReboot');usage(s+' now','Usage: !reset_pc confirm');}
});
test('settings full options, aliases, position and field discovery match source',()=>{
 eq('setting',{Settings:{reference:null,model:null,effort:null,speed:null}});
 eq('settings --model',{SettingsOptions:{reference:null,field:'model'}});
 eq('settings --model target',{Settings:{reference:null,model:'target',effort:null,speed:null}});
 eq('settings target --model',{SettingsOptions:{reference:'target',field:'model'}});
 eq('settings --reasoning target',{Settings:{reference:null,model:null,effort:'target',speed:null}});
 eq('settings --speed fast abc --model "Model B" --effort ultra',{Settings:{reference:'abc',model:'Model B',effort:'ultra',speed:'fast'}});
 eq('settings --speed abc',{Settings:{reference:null,model:null,effort:null,speed:'abc'}});
});
test('settings POSIX-like source shell quoting preserves literal values and escaped whitespace',()=>{
 eq('settings "my ref" --model "Model B"',{Settings:{reference:'my ref',model:'Model B',effort:null,speed:null}});
 eq('settings ref\\ name --model a\\ b',{Settings:{reference:'ref name',model:'a b',effort:null,speed:null}});
 eq("settings --model 'a\\b'",{Settings:{reference:null,model:'a\\b',effort:null,speed:null}});
 eq('settings --model a"b"c',{Settings:{reference:null,model:'abc',effort:null,speed:null}});
 eq("settings --model \"a'b\"",{Settings:{reference:null,model:"a'b",effort:null,speed:null}});
 eq('settings --model " x "',{Settings:{reference:null,model:' x ',effort:null,speed:null}});
 for(const s of ['settings "a','settings a\\',"settings 'a"]){assert.throws(()=>plan(s),(e:unknown)=>e instanceof PrefixPlanError&&e.message.endsWith('\nERROR: No closing quotation'));}
});
test('settings rejects duplicate, mixed discovery/mutation, unknown options and empty fields',()=>{
 for(const s of ['settings a b','settings ""','settings --model ""','settings --model "   "','settings --model a --model b','settings --effort a --reasoning b','settings --speed --model','settings --model a --speed','settings --model --speed a','settings --unknown a','settings --model=x'])usage(s);
 for(const s of ['settings --auto-reserve','settings --auto-reserve=true','settings ref --auto-reserve=false'])usage(s,AUTO_RESERVE_REMOVED);
});
test('Unicode whitespace is Rust whitespace, not JavaScript BOM whitespace',()=>{
 eq('\u0085list\u00852\u0085',{List:{limit:2n}});eq('list\u20282',{List:{limit:2n}});
 assert.throws(()=>plan('\ufeffhelp'),(e:unknown)=>e instanceof PrefixPlanError&&e.kind==='Unknown'&&e.value==='\ufeffhelp');
 eq('new\u0085😀',{New:{prompt:'😀'}});for(const s of ['\ud800','new \udc00'])assert.throws(()=>plan(s),TypeError);
});
test('unknown names are explicit and outputs are immutable descriptions',()=>{
 assert.throws(()=>plan('DOES_NOT_EXIST'),(e:unknown)=>e instanceof PrefixPlanError&&e.kind==='Unknown'&&e.value==='does_not_exist'&&e.message==='unknown prefix command: !does_not_exist');
 const p=plan('settings ref --model x');assert.ok(Object.isFrozen(p));assert.ok('Settings' in Object(p));assert.ok(Object.isFrozen((p as any).Settings));assert.throws(()=>{(p as any).Settings.model='changed';},TypeError);
 for(const v of [null,42,{},undefined])assert.throws(()=>plan(v as any),TypeError);
});
