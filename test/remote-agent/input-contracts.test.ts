import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseTerminalRequest} from '../../src/remote-agent/terminal-request.ts';
import {parseComputerRequest} from '../../src/remote-agent/computer-request.ts';
import {RemoteProtocolError} from '../../src/remote-agent/handshake.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const budget=12_000_000,window='termwin_0123456789abcdef',observation='twobs_0123456789abcdef';
const terminal=(v:unknown)=>parseTerminalRequest(serializeSerdeValue(v),budget);
const computer=(v:unknown)=>parseComputerRequest(serializeSerdeValue(v),budget);
const fails=(call:()=>unknown,kind:'Json'|'Validation',detail?:string)=>assert.throws(call,(e:unknown)=>e instanceof RemoteProtocolError&&e.kind===kind&&(detail===undefined||e.message.includes(detail)));
const exec={kind:'terminal_exec',command:'echo 안녕'};
const observed={window_id:1n,observation_id:'observed'};
const click={kind:'computer_click',...observed,x:0n,y:100000n};
test('all nine terminal variants decode source defaults and immutable DTOs',()=>{
 const a=terminal(exec);assert.equal(a.kind,'terminal_exec');if(a.kind!=='terminal_exec')throw Error('variant');
 assert.equal(a.terminal_id,null);assert.equal(a.shell,'auto');assert.equal(a.cwd,null);assert.equal(a.timeout_seconds,300n);assert.equal(a.cancel_previous,false);
 assert.equal(Object.getPrototypeOf(a.environment),null);assert.ok(Object.isFrozen(a.environment));assert.ok(Object.isFrozen(a));
 assert.deepEqual(terminal({kind:'terminal_window_open'}),{kind:'terminal_window_open',shell:'powershell',cwd:null});
 assert.deepEqual(terminal({kind:'terminal_window_list'}),{kind:'terminal_window_list'});
 for(const kind of ['terminal_window_close','terminal_window_capture','terminal_window_activate'])assert.equal(terminal({kind,terminal_window_id:window}).kind,kind);
 assert.equal(terminal({kind:'terminal_window_type',terminal_window_id:window,observation_id:observation,text:'x'}).kind,'terminal_window_type');
 const keys=terminal({kind:'terminal_window_keys',terminal_window_id:window,observation_id:observation,keys:['CTRL','A']});assert.equal(keys.kind,'terminal_window_keys');if(keys.kind==='terminal_window_keys')assert.ok(Object.isFrozen(keys.keys));
 assert.equal(terminal({kind:'terminal_window_interrupt',terminal_window_id:window,observation_id:observation}).kind,'terminal_window_interrupt');
});
test('terminal complete deserialization precedes semantic checks; optional null differs from default',()=>{
 for(const [key,value] of [['shell',null],['environment',null],['timeout_seconds',null],['cancel_previous',null],['timeout_seconds',65536n],['timeout_seconds',-1n],['command',null]] as const)fails(()=>terminal({...exec,[key]:value}),'Json');
 for(const token of ['1.0','1e0','-0','"1"','true'])fails(()=>parseTerminalRequest(`{"kind":"terminal_exec","command":"x","timeout_seconds":${token}}`,budget),'Json');
 fails(()=>terminal({...exec,command:'',cancel_previous:1n}),'Json');
 fails(()=>terminal({...exec,command:''}),'Validation','command:');
 assert.equal(terminal({...exec,terminal_id:null,cwd:null}).kind,'terminal_exec');
 for(const timeout_seconds of [0n,3601n,65535n])fails(()=>terminal({...exec,timeout_seconds}),'Validation','timeout_seconds:');
 for(const timeout_seconds of [1n,3600n])assert.equal(terminal({...exec,timeout_seconds}).kind,'terminal_exec');
 for(const shell of ['auto','powershell','cmd','sh','bash'])assert.equal(terminal({...exec,shell}).kind,'terminal_exec');
 fails(()=>terminal({...exec,shell:'zsh'}),'Json');fails(()=>terminal({kind:'terminal_window_open',shell:'auto'}),'Json');
});
test('terminal strict identifiers reject final LF and case; strings count Unicode scalars',()=>{
 for(const terminal_id of ['term_0123456789abcdef\n','TERM_0123456789abcdef','term_0123456789abcde'])fails(()=>terminal({...exec,terminal_id}),'Validation','terminal_id:');
 assert.equal(terminal({...exec,terminal_id:'term_0123456789abcdef',command:'😀'.repeat(32768),cwd:'😀'.repeat(1000)}).kind,'terminal_exec');
 fails(()=>terminal({...exec,command:'😀'.repeat(32769)}),'Validation','command:');fails(()=>terminal({...exec,cwd:''}),'Validation','cwd:');
 for(const [key,value] of [['terminal_window_id',window+'\r\n'],['observation_id',observation+'\n']] as const)fails(()=>terminal({kind:'terminal_window_type',terminal_window_id:window,observation_id:observation,text:'x',[key]:value}),'Validation',key+':');
 for(const keys of [[],[''],['x'.repeat(21)],['a','b','c','d','e']])fails(()=>terminal({kind:'terminal_window_keys',terminal_window_id:window,observation_id:observation,keys}),'Validation','keys:');
 assert.equal(terminal({kind:'terminal_window_keys',terminal_window_id:window,observation_id:observation,keys:['😀'.repeat(20)]}).kind,'terminal_window_keys');
});
test('terminal environment remains an owned map and follows Rust UTF8 ordering',()=>{
 const v=terminal({...exec,environment:JSON.parse('{"__proto__":"safe","constructor":"x","toString":"y"}')});
 if(v.kind!=='terminal_exec')throw Error('variant');assert.equal(v.environment.__proto__,'safe');assert.equal(Object.getPrototypeOf(v.environment),null);assert.ok(Object.isFrozen(v.environment));
 for(const environment of [{A:1n},{A:null},[]])fails(()=>terminal({...exec,environment}),'Json');
 for(const environment of [{'':'x'},{'a=b':'x'},{'a\0':'x'},{A:'x\0'},Object.fromEntries(Array.from({length:101},(_,i)=>['v'+i,'x']))])fails(()=>terminal({...exec,environment}),'Validation','environment');
 assert.equal(terminal({...exec,environment:{['😀'.repeat(1024)]:'😀'.repeat(32767)}}).kind,'terminal_exec');
 fails(()=>terminal({...exec,environment:{A:'😀'.repeat(32768)}}),'Validation','environment.value');
 // UTF16 would sort astral first; Rust UTF8 sorts U+E000 first. First error must be its invalid name.
 fails(()=>terminal({...exec,environment:{'😀':'\0','\ue000=':'x'}}),'Validation','environment.name:');
});
test('all twelve computer variants preserve exact u64 and source defaults',()=>{
 for(const kind of ['computer_list_windows','computer_stop'])assert.equal(computer({kind}).kind,kind);
 for(const app of ['chrome','notepad'])assert.equal(computer({kind:'computer_launch',app}).kind,'computer_launch');
 for(const kind of ['computer_activate','computer_screenshot']){const v=computer({kind,window_id:18446744073709551615n});assert.ok('window_id'in v);assert.equal(v.window_id,18446744073709551615n);}
 assert.deepEqual(computer(click),{...click,button:'left',click_count:1n});
 assert.equal(computer({kind:'computer_drag',...observed,start_x:0n,start_y:1n,end_x:100000n,end_y:2n}).kind,'computer_drag');
 assert.deepEqual(computer({kind:'computer_scroll',...observed,x:0n,y:0n,delta_y:-1n}),{kind:'computer_scroll',...observed,x:0n,y:0n,delta_x:0n,delta_y:-1n});
 assert.equal(computer({kind:'computer_type_text',...observed,text:'x'}).kind,'computer_type_text');
 const keys=computer({kind:'computer_press_keys',...observed,keys:['']});assert.equal(keys.kind,'computer_press_keys');if(keys.kind==='computer_press_keys')assert.ok(Object.isFrozen(keys.keys));
 assert.equal(computer({kind:'computer_close',...observed}).kind,'computer_close');
 assert.equal(computer({kind:'computer_set_clipboard',...observed,text:''}).kind,'computer_set_clipboard');
});
test('computer integer wire types and validation ranges are different checks',()=>{
 for(const window_id of [-1n,null,'1'])fails(()=>computer({...click,window_id}),'Json');
 fails(()=>parseComputerRequest('{"kind":"computer_activate","window_id":18446744073709551616}',budget),'Json');
 fails(()=>computer({...click,window_id:0n}),'Validation','window_id:');
 for(const token of ['1.0','1e0','-0'])fails(()=>parseComputerRequest(`{"kind":"computer_activate","window_id":${token}}`,budget),'Json');
 for(const x of [-1n,4294967296n])fails(()=>computer({...click,x}),'Json');
 for(const x of [100001n,4294967295n])fails(()=>computer({...click,x}),'Validation','x:');
 for(const click_count of [-1n,256n,null])fails(()=>computer({...click,click_count}),'Json');
 for(const click_count of [0n,4n,255n])fails(()=>computer({...click,click_count}),'Validation','click_count:');
 for(const button of ['left','right','middle'])assert.equal(computer({...click,button,click_count:3n}).kind,'computer_click');
 fails(()=>computer({...click,button:null}),'Json');fails(()=>computer({...click,window_id:0n,button:3n}),'Json');
});
test('computer scroll, coordinate and observation boundaries use original ordering',()=>{
 const base={kind:'computer_scroll',...observed,x:0n,y:0n};
 fails(()=>computer(base),'Validation','non-zero scroll');
 for(const delta_x of [-10000n,10000n])assert.equal(computer({...base,delta_x}).kind,'computer_scroll');
 for(const delta_x of [-2147483649n,2147483648n])fails(()=>computer({...base,delta_x}),'Json');
 for(const delta_x of [-10001n,10001n])fails(()=>computer({...base,delta_x}),'Validation','delta:');
 fails(()=>computer({...base,x:100001n,delta_x:10001n}),'Validation','x:');
 fails(()=>computer({...click,window_id:0n,observation_id:'',x:100001n}),'Validation','window_id:');
 fails(()=>computer({...click,observation_id:'x'.repeat(7),x:100001n}),'Validation','observation_id:');
 assert.equal(computer({...click,observation_id:'😀'.repeat(100)}).kind,'computer_click');
 fails(()=>computer({...click,observation_id:'😀'.repeat(101)}),'Validation','observation_id:');
 for(const key of ['start_x','start_y','end_x','end_y'])fails(()=>computer({kind:'computer_drag',...observed,start_x:0n,start_y:0n,end_x:0n,end_y:0n,[key]:100001n}),'Validation',key+':');
});
test('computer keys intentionally allow empty or long individual strings unlike terminal keys',()=>{
 assert.equal(computer({kind:'computer_press_keys',...observed,keys:['','x'.repeat(1000)]}).kind,'computer_press_keys');
 for(const keys of [[],['a','b','c','d','e']])fails(()=>computer({kind:'computer_press_keys',...observed,keys}),'Validation','keys:');
 fails(()=>computer({kind:'computer_press_keys',...observed,keys:[1n]}),'Json');
 assert.equal(computer({kind:'computer_type_text',...observed,text:'😀'.repeat(4096)}).kind,'computer_type_text');
 for(const text of ['','😀'.repeat(4097)])fails(()=>computer({kind:'computer_type_text',...observed,text}),'Validation','text:');
 assert.equal(computer({kind:'computer_set_clipboard',...observed,text:'😀'.repeat(100000)}).kind,'computer_set_clipboard');
 fails(()=>computer({kind:'computer_set_clipboard',...observed,text:'😀'.repeat(100001)}),'Validation','text:');
});
test('both families fail closed on unknown fields, malformed JSON and explicit frame budgets',()=>{
 for(const [parse,good] of [[parseTerminalRequest,exec],[parseComputerRequest,click]] as const){
  const raw=serializeSerdeValue(good),bytes=Buffer.byteLength(raw);assert.ok(parse(raw,bytes));assert.throws(()=>parse(raw,bytes-1),RangeError);
  for(const budget of [0,-1,12000001,NaN,Infinity,1.5])assert.throws(()=>parse(raw,budget),RangeError);
  for(const input of [{...good,extra:null},{...good,protocol_version:10n},{kind:'unknown'},[],null])fails(()=>parse(serializeSerdeValue(input),12000000),'Json');
  for(const raw of ['{','{"kind":"computer_stop"} garbage','{"kind":"\\ud800"}'])fails(()=>parse(raw,12000000),'Json');
 }
 assert.equal(parseTerminalRequest('{"kind":"bad","kind":"terminal_window_list"}',budget).kind,'terminal_window_list');
 assert.equal(parseComputerRequest('{"kind":"computer_stop","kind":"computer_list_windows"}',budget).kind,'computer_list_windows');
 fails(()=>parseTerminalRequest('{"kind":"terminal_window_list","__proto__":{}}',budget),'Json');
});
