import {it} from 'node:test';import assert from 'node:assert/strict';
import {remoteCommandMeta,remoteSessionActivation,remoteCommandIsMutation,remoteBindingError,remoteExpiredResult,remoteCancelledResult,remoteSessionError,remoteRequestConflict} from '../../src/remote-agent/dispatch-contract.ts';
import {parseGatewayCommand} from '../../src/remote-agent/gateway-command.ts';import type {GatewayCommand} from '../../src/remote-agent/gateway-command.ts';import type {ProjectOperation} from '../../src/remote-agent/project-request.ts';
const parse=(fields:object)=>parseGatewayCommand(JSON.stringify({request_id:'request',thread_id:'thread',...fields}),12000000,0);
it('metadata preserves all seven decoded commands and nullable session identity',()=>{
 const values=[{type:'project_info'},{type:'list_files',pattern:'*',limit:1},{type:'read_file',path:'x',start_line:1,max_lines:1},{type:'write_file',path:'x',content:''},{type:'project_operation',operation:{kind:'repo_status'}},{type:'project_session',computer_session_id:'abcdefghijklmnop',computer_session_generation:1},{type:'device_session',computer_session_id:'abcdefghijklmnop',computer_session_generation:2,working_directory:'/fixture',expires_at:'2026-10-11T00:00:00Z'}];
 for(const value of values){const c=parse(value),m=remoteCommandMeta(c);assert.equal(m.deadline_at,c.deadline_at);assert.equal(m.computer_session_id,c.computer_session_id);assert.equal(m.request_id,'request');assert.equal(m.thread_id,'thread');assert.equal(Object.isFrozen(m),true);}
 assert.equal(remoteCommandMeta(parse({type:'project_info',computer_session_id:'abcdefghijklmnop'})).computer_session_id,'abcdefghijklmnop');
});
it('only project/device session commands activate with original u64 generation and exact mode',()=>{
 assert.deepEqual(remoteSessionActivation(parse({type:'project_session',computer_session_id:'abcdefghijklmnop',computer_session_generation:1})),{session_id:'abcdefghijklmnop',session_generation:1n,computer_mode:'project'});
 const c=parseGatewayCommand('{"type":"device_session","request_id":"r","thread_id":"t","computer_session_id":"abcdefghijklmnop","computer_session_generation":18446744073709551615,"working_directory":"/f","expires_at":"2026-10-11T00:00:00Z"}',10000,0);assert.equal(remoteSessionActivation(c)?.session_generation,18446744073709551615n);assert.equal(remoteSessionActivation(c)?.computer_mode,'device');assert.equal(remoteSessionActivation(parse({type:'project_info'})),null);
});
it('all39 operation kinds preserve source mutation-cache classification including surprising readonly UI and terminal exceptions',()=>{
 const readonly=['project_rules','project_status','code_search','command_list','repo_status','repo_diff','list_images','retrieve_image','checkpoint_list','checkpoint_show','terminal_exec'] as const;
 const mutation=['file_apply_patch','file_create','command_run','git_commit','git_push','save_image','save_image_from_url','checkpoint_restore','computer_list_windows','computer_stop','computer_launch','computer_activate','computer_screenshot','computer_click','computer_drag','computer_scroll','computer_type_text','computer_set_clipboard','computer_press_keys','computer_close','terminal_window_open','terminal_window_list','terminal_window_close','terminal_window_capture','terminal_window_activate','terminal_window_type','terminal_window_keys','terminal_window_interrupt'] as const;
 assert.equal(new Set([...readonly,...mutation]).size,39);
 // Kind-only synthetic owned DTOs isolate classification; payload parsing is tested separately.
 for(const [kinds,expected] of [[readonly,false],[mutation,true]] as const)for(const kind of kinds){const c={...parse({type:'project_info'}),type:'project_operation',operation:Object.freeze({kind}) as ProjectOperation} as GatewayCommand;assert.equal(remoteCommandIsMutation(c),expected,kind);}
 assert.equal(remoteCommandIsMutation(parse({type:'write_file',path:'x',content:''})),true);assert.equal(remoteCommandIsMutation(parse({type:'read_file',path:'x',start_line:1,max_lines:1})),false);
});
it('central source result literals remain exact and immutable without changing request identity',()=>{
 assert.deepEqual(remoteBindingError('','binding_expired'),{type:'operation_error',request_id:'',error_code:'binding_expired',message:'The local project binding expired. Run !pro again.'});assert.equal(remoteBindingError('r','binding_missing').message,'The Codex thread is not bound on this device.');assert.equal(remoteBindingError('r','other').error_code,'other');
 assert.equal(remoteExpiredResult('r').message,'The remote project request expired before it could run.');assert.equal(remoteCancelledResult('r').message,'The remote project request was cancelled because the local bridge disconnected.');assert.equal(remoteSessionError('r','detail').error_code,'computer_control');assert.equal(remoteRequestConflict('r').message,'The request ID was reused with different command content.');assert.equal(Object.isFrozen(remoteRequestConflict('r')),true);
});
it('classification does not invoke active fields or silently treat unknown variants as harmless',()=>{
 let calls=0;const c={get type(){calls++;return 'project_info';}} as unknown as GatewayCommand;assert.throws(()=>remoteCommandIsMutation(c),TypeError);assert.equal(calls,0);assert.throws(()=>remoteCommandIsMutation({type:'future'} as unknown as GatewayCommand),TypeError);
 const op={...parse({type:'project_info'}),type:'project_operation',operation:{get kind(){calls++;return 'repo_status';}}} as GatewayCommand;assert.throws(()=>remoteCommandIsMutation(op),TypeError);assert.equal(calls,0);
});
