import {it} from 'node:test';import assert from 'node:assert/strict';
import {parseTerminalOutput} from '../../src/remote-agent/terminal-output.ts';
import {RemoteProtocolError} from '../../src/remote-agent/handshake.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const tid='term_'+'a'.repeat(16),wid='termwin_'+'a'.repeat(16),oid='twobs_'+'a'.repeat(16),digest='a'.repeat(64);
const window={terminal_window_id:wid,window_id:1n,process_id:2n,shell:'cmd',cwd:'/',title:'x'};
const receipt={receipt_id:'tr_'+'a'.repeat(16),terminal_id:tid,command_digest:digest,shell:'auto',cwd_scope:'external_absolute',exit_code:0n,stdout_bytes:999n,stderr_bytes:0n,duration_ms:1n,timed_out:false,cancelled:false,truncated:false};
const exec={kind:'terminal_exec',terminal_id:tid,process_id:1n,exit_code:0n,stdout:'',stderr:'',cwd:'/',duration_ms:1n,timed_out:false,cancelled:false,truncated:false,receipt};
const action={receipt_id:'twrcpt_'+'a'.repeat(16),terminal_window_id:wid,identity_digest:digest,action:'activate',activated:false,completed_at:'2026-10-11T00:00:00.123456789Z'};
const capture={kind:'terminal_window_capture',window,observation_id:oid,identity_digest:digest,rect:{left:-1n,top:0n,width:1n,height:1n},data_base64:'123456789012',captured_at:'2016-12-31T23:59:60.5Z'};
const parse=(value:unknown)=>parseTerminalOutput(serializeSerdeValue(value),12000000);
function fails(value:unknown,kind='Validation'){assert.throws(()=>parse(value),e=>e instanceof RemoteProtocolError&&e.kind===kind);}
it('all six terminal output variants preserve typed defaults and nanosecond or leap timestamps',()=>{
 for(const input of [exec,{kind:'terminal_window_open',window},{kind:'terminal_window_list',windows:[window]},{kind:'terminal_window_close',terminal_window_id:wid},capture,{kind:'terminal_window_action',window,receipt:action}])assert.equal(parse(input).kind,input.kind);
 const shot=parse(capture);if(shot.kind==='terminal_window_capture'){assert.equal(shot.media_type,'image/png');assert.equal(shot.window.running,true);assert.equal(shot.captured_at.nanosecond,1500000000n);}
 const act=parse({kind:'terminal_window_action',window,receipt:action});if(act.kind==='terminal_window_action'){assert.equal(act.receipt.observation_id,null);assert.equal(act.receipt.unicode_chars,0n);assert.deepEqual(act.receipt.keys,[]);assert.equal(act.receipt.completed_at.nanosecond,123456789n);}
});
it('execution receipt identity and all six paired outcome fields must match',()=>{
 for(const update of [{terminal_id:'term_'+'b'.repeat(16)},{exit_code:2n},{duration_ms:2n},{timed_out:true},{cancelled:true},{truncated:true}])fails({...exec,receipt:{...receipt,...update}});
 // Byte counters are not tied to current string length by the source contract.
 assert.equal(parse(exec).kind,'terminal_exec');
});
it('missing exit code requires exactly a supported stop reason without both flags',()=>{
 const {exit_code:_,...noExit}=receipt;const {exit_code:__,...noOutputExit}=exec;
 fails({...noOutputExit,receipt:noExit});
 assert.equal(parse({...noOutputExit,timed_out:true,receipt:{...noExit,timed_out:true}}).kind,'terminal_exec');
 assert.equal(parse({...noOutputExit,cancelled:true,receipt:{...noExit,cancelled:true}}).kind,'terminal_exec');
 fails({...noOutputExit,timed_out:true,cancelled:true,receipt:{...noExit,timed_out:true,cancelled:true}});
});
it('terminal window action grammar preserves activate type keys and exact CTRL C interrupt',()=>{
 const cases=[action,{...action,action:'type',observation_id:oid,unicode_chars:4096n},{...action,action:'keys',observation_id:oid,keys:['X']},{...action,action:'interrupt',observation_id:oid,keys:['CTRL','C']}];
 for(const r of cases)assert.equal(parse({kind:'terminal_window_action',window,receipt:r}).kind,'terminal_window_action');
 for(const r of [{...action,observation_id:oid},{...action,action:'type',observation_id:oid,unicode_chars:0n},{...action,action:'type',observation_id:oid,unicode_chars:4097n},{...action,action:'interrupt',observation_id:oid,keys:['ctrl','c']},{...action,action:'keys',observation_id:oid,keys:['']},{...action,terminal_window_id:'termwin_'+'b'.repeat(16)}])fails({kind:'terminal_window_action',window,receipt:r});
});
it('strict structs and enum defaults reject unknown fields and explicit nulls before semantic checks',()=>{
 fails({...exec,process_id:0n,receipt:{...receipt,shell:'invalid'}},'Json');
 fails({kind:'terminal_window_open',window:{...window,running:null}},'Json');
 fails({kind:'terminal_window_close',terminal_window_id:wid,closed:null},'Json');
 fails({...capture,media_type:null},'Json');fails({...capture,rect:{...capture.rect,kind:'extra'}},'Json');
 fails({kind:'terminal_window_action',window,receipt:{...action,keys:null}},'Json');fails({...capture,captured_at:'2026-02-30T00:00:00Z'},'Json');
});
it('identifier final newline uppercase digests and nonpositive window rectangles fail closed',()=>{
 fails({...exec,terminal_id:tid+'\n'});fails({...exec,receipt:{...receipt,command_digest:'A'.repeat(64)}});
 fails({kind:'terminal_window_open',window:{...window,running:false}});fails({kind:'terminal_window_open',window:{...window,process_id:0n}});
 fails({...capture,rect:{...capture.rect,width:0n}});fails({...capture,data_base64:'short'});fails({kind:'terminal_window_close',terminal_window_id:wid,closed:false});
});
it('signed integer precision and exact wire types survive receipt deserialization',()=>{
 const valid={...exec,exit_code:-9223372036854775808n,receipt:{...receipt,exit_code:-9223372036854775808n}};assert.equal(parse(valid).kind,'terminal_exec');
 const raw=serializeSerdeValue(valid);assert.throws(()=>parseTerminalOutput(raw.replaceAll('-9223372036854775808','1.0'),12000000),e=>e instanceof RemoteProtocolError&&e.kind==='Json');
 assert.throws(()=>parseTerminalOutput(raw,Buffer.byteLength(raw)-1),RangeError);
});
