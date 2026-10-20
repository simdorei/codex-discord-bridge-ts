import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseProjectOperation,projectRequestLifetimeSeconds} from '../../src/remote-agent/project-request.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const budget=12000000;
test('all 39 source operation kinds route through their exact typed family',()=>{
 const observed={window_id:1n,observation_id:'observed'},terminal={terminal_window_id:'termwin_0123456789abcdef',observation_id:'twobs_0123456789abcdef'};
 const examples=[
 ...['project_rules','project_status','command_list','repo_status','repo_diff','list_images','checkpoint_list'].map(kind=>({kind})),
 {kind:'code_search',query:'x'},{kind:'file_apply_patch',changes:[{action:'create',path:'a',content:''}]},{kind:'file_create',path:'a',content:''},{kind:'command_run',command_id:'x'},{kind:'git_commit',message:'x',paths:['']},{kind:'git_push'},
 {kind:'save_image',path:'a',data_base64:'!!!!'},{kind:'save_image_from_url',path:'a',url:'https://example.com'},{kind:'retrieve_image',path:'a'},...['checkpoint_show','checkpoint_restore'].map(kind=>({kind,checkpoint_id:'cp_0123456789abcdef'})),
 ...['computer_list_windows','computer_stop'].map(kind=>({kind})),{kind:'computer_launch',app:'chrome'},...['computer_activate','computer_screenshot'].map(kind=>({kind,window_id:1n})),
 {kind:'computer_click',...observed,x:0n,y:0n},{kind:'computer_drag',...observed,start_x:0n,start_y:0n,end_x:0n,end_y:0n},{kind:'computer_scroll',...observed,x:0n,y:0n,delta_x:1n},{kind:'computer_type_text',...observed,text:'x'},{kind:'computer_press_keys',...observed,keys:['']},{kind:'computer_close',...observed},{kind:'computer_set_clipboard',...observed,text:''},
 {kind:'terminal_exec',command:'x'},{kind:'terminal_window_open'},{kind:'terminal_window_list'},...['terminal_window_close','terminal_window_capture','terminal_window_activate'].map(kind=>({kind,terminal_window_id:terminal.terminal_window_id})),{kind:'terminal_window_type',...terminal,text:'x'},{kind:'terminal_window_keys',...terminal,keys:['x']},{kind:'terminal_window_interrupt',...terminal}];
 assert.equal(examples.length,39);assert.equal(new Set(examples.map(x=>x.kind)).size,39);
 for(const example of examples){const value=parseProjectOperation(serializeSerdeValue(example),budget);assert.equal(value.kind,example.kind);assert.ok(Object.isFrozen(value));}
 for(const kind of ['computer_unknown','terminal_unknown','unknown'])assert.throws(()=>parseProjectOperation(serializeSerdeValue({kind}),budget));
});
test('request lifetimes preserve original defaults, timeout grace and Git special cases',()=>{
 for(const [input,expected] of [[{kind:'command_run',command_id:'x'},75n],[{kind:'command_run',command_id:'x',timeout_seconds:300n},315n],[{kind:'terminal_exec',command:'x'},315n],[{kind:'terminal_exec',command:'x',timeout_seconds:3600n},3615n],[{kind:'git_push'},315n],[{kind:'repo_status'},135n],[{kind:'repo_diff'},135n],[{kind:'project_status'},135n],[{kind:'git_commit',message:'x',paths:['']},135n],[{kind:'computer_stop'},60n],[{kind:'terminal_window_list'},60n],[{kind:'retrieve_image',path:'x'},60n]] as const)assert.equal(projectRequestLifetimeSeconds(parseProjectOperation(serializeSerdeValue(input),budget)),expected);
});
