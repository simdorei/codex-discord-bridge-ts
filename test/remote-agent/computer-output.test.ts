import {it} from 'node:test';import assert from 'node:assert/strict';
import {parseComputerOutput} from '../../src/remote-agent/computer-output.ts';
import {RemoteProtocolError} from '../../src/remote-agent/handshake.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const window={window_id:18446744073709551615n,title:'',process_name:'',left:-9223372036854775808n,top:9223372036854775807n,width:1n,height:1n,active:false};
const parse=(value:unknown)=>parseComputerOutput(serializeSerdeValue(value),12000000);
function fails(value:unknown,kind:string){assert.throws(()=>parse(value),e=>e instanceof RemoteProtocolError&&e.kind===kind);}
it('four computer result variants decode source defaults and lossless window coordinates',()=>{
 assert.deepEqual(structuredClone(parse({kind:'computer_windows',windows:[window]})),{kind:'computer_windows',windows:[window]});
 const shot=parse({kind:'computer_screenshot',observation_id:'😀'.repeat(8),window,data_base64:'not-base64!!'});
 assert.equal(shot.kind,'computer_screenshot');if(shot.kind==='computer_screenshot'){assert.equal(shot.media_type,'image/png');assert.equal(Object.isFrozen(shot.window),true);}
 assert.deepEqual(structuredClone(parse({kind:'computer_action',action:'click',message:''})),{kind:'computer_action',action:'click',window_id:null,message:''});
 assert.deepEqual(structuredClone(parse({kind:'computer_stop',message:''})),{kind:'computer_stop',stopped:true,message:''});
});
it('all nine action names are exact and an optional window id is either null or positive',()=>{
 for(const action of ['activate','launch','click','drag','scroll','type_text','press_keys','close','set_clipboard'])assert.equal(parse({kind:'computer_action',action,message:''}).kind,'computer_action');
 fails({kind:'computer_action',action:'Click',message:''},'Json');fails({kind:'computer_action',action:'click',window_id:0n,message:''},'Validation');
 fails({kind:'computer_action',action:'click',window_id:-1n,message:''},'Json');
});
it('explicit null does not use nonnullable defaults and unknown nested fields are rejected',()=>{
 fails({kind:'computer_stop',stopped:null,message:''},'Json');fails({kind:'computer_stop',stopped:false,message:''},'Validation');
 fails({kind:'computer_screenshot',observation_id:'12345678',window,media_type:null,data_base64:'123456789012'},'Json');
 fails({kind:'computer_screenshot',observation_id:'12345678',window,media_type:'image/jpeg',data_base64:'123456789012'},'Json');
 fails({kind:'computer_windows',windows:[{...window,kind:'injected'}]},'Json');fails({kind:'computer_stop',message:'',extra:true},'Json');
});
it('semantic checks follow observation then window then image length after complete decoding',()=>{
 const shot={kind:'computer_screenshot',observation_id:'short',window:{...window,width:0n},data_base64:'short'};
 assert.throws(()=>parse(shot),e=>e instanceof RemoteProtocolError&&e.kind==='Validation'&&e.message.includes('observation_id'));
 assert.throws(()=>parse({...shot,observation_id:'12345678'}),e=>e instanceof RemoteProtocolError&&e.kind==='Validation'&&e.message.includes('window'));
 assert.throws(()=>parse({...shot,observation_id:'12345678',window}),e=>e instanceof RemoteProtocolError&&e.kind==='Validation'&&e.message.includes('data_base64'));
 fails({...shot,data_base64:3n},'Json');
 for(const field of ['window_id','width','height'])fails({kind:'computer_windows',windows:[{...window,[field]:0n}]},'Validation');
});
it('native integer representation and source Unicode-scalar limits remain distinct from UTF8 frame budget',()=>{
 const raw=serializeSerdeValue({kind:'computer_windows',windows:[window]});
 assert.throws(()=>parseComputerOutput(raw.replace('-9223372036854775808','-9223372036854775809'),1000),e=>e instanceof RemoteProtocolError&&e.kind==='Json');
 assert.throws(()=>parseComputerOutput(raw.replace('18446744073709551615','1.0'),1000),e=>e instanceof RemoteProtocolError&&e.kind==='Json');
 assert.equal(parse({kind:'computer_screenshot',observation_id:'😀'.repeat(100),window,data_base64:'x'.repeat(12)}).kind,'computer_screenshot');
 fails({kind:'computer_screenshot',observation_id:'😀'.repeat(101),window,data_base64:'x'.repeat(12)},'Validation');
 assert.throws(()=>parseComputerOutput(raw,Buffer.byteLength(raw)-1),RangeError);
});
