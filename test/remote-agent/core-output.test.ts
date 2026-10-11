import {it} from 'node:test';
import assert from 'node:assert/strict';
import {parseCoreOutput} from '../../src/remote-agent/core-output.ts';
import {RemoteProtocolError} from '../../src/remote-agent/handshake.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const image={path:'',media_type:'arbitrary',size_bytes:18446744073709551615n};
const checkpoint={checkpoint_id:'',created_at:'not a datetime',reason:''};
const fixtures=[
 {kind:'project_rules',rules:[{path:'',content:''}]},
 {kind:'project_status',branch:'',dirty_files:[''],staged_files:[],rule_files:[],command_ids:[]},
 {kind:'code_search',matches:[{path:'',line:1n,snippet:''}]},
 {kind:'file_apply_patch',applied:[{path:'',action:'move',destination:null,added_lines:0n,removed_lines:0n}],checkpoint_id:''},
 {kind:'file_create',path:'',sha256:'not a hash',bytes_written:0n,checkpoint_id:''},
 {kind:'command_list',commands:[{command_id:'',display:'',source:'',risk_tier:'destructive'}]},
 {kind:'command_run',command_id:'',exit_code:-9223372036854775808n,stdout:'',stderr:'',duration_ms:18446744073709551615n,truncated:false},
 {kind:'repo_status',branch:'',dirty_files:[],staged_files:[],remotes:[],upstream:null,ahead:0n,behind:0n},
 {kind:'repo_diff',files:[{path:'',added:0n,removed:0n}],summary:'',patch:'',truncated:true},
 {kind:'git_commit',commit:'',branch:'',staged_files:[]},
 {kind:'git_push',remote:'',branch:'',output:''},
 {kind:'image_save',image,sha256:''},
 {kind:'image_list',images:[image]},
 {kind:'image_retrieve',image,data_base64:'not base64'},
 {kind:'checkpoint_list',checkpoints:[checkpoint]},
 {kind:'checkpoint_show',checkpoint,patch:''},
 {kind:'checkpoint_restore',checkpoint_id:'',restored_files:['']},
];
const parse=(v:unknown)=>parseCoreOutput(serializeSerdeValue(v),12000000);
function expectKind(run:()=>unknown,kind:string){assert.throws(run,e=>e instanceof RemoteProtocolError&&e.kind===kind);}
it('all seventeen core output variants preserve source data without inventing path, hash or date constraints',()=>{
 assert.equal(fixtures.length,17);assert.equal(new Set(fixtures.map(x=>x.kind)).size,17);
 for(const fixture of fixtures){const actual=parse(fixture);assert.deepEqual(structuredClone(actual),fixture);assert.equal(Object.isFrozen(actual),true);}
});
it('every output denies unknown top-level fields and missing required members',()=>{
 for(const fixture of fixtures){expectKind(()=>parse({...fixture,extra:true}),'Json');const invalid={...fixture} as Record<string,unknown>;delete invalid[Object.keys(invalid).find(k=>k!=='kind')!];expectKind(()=>parse(invalid),'Json');}
 expectKind(()=>parse({kind:'__proto__'}),'Json');expectKind(()=>parse({kind:'toString'}),'Json');
});
it('nested structs deny unknown kind and prototype-shaped fields without modifying prototypes',()=>{
 expectKind(()=>parse({kind:'project_rules',rules:[{path:'',content:'',kind:'extra'}]}),'Json');
 expectKind(()=>parseCoreOutput('{"kind":"project_rules","rules":[{"path":"","content":"","__proto__":{}}]}',1000),'Json');
 assert.equal(Object.hasOwn(Object.prototype,'path'),false);
});
it('optional destination and upstream normalize only missing or explicit null',()=>{
 const patch=parse({kind:'file_apply_patch',applied:[{path:'',action:'add',added_lines:0n,removed_lines:0n}],checkpoint_id:''});
 assert.equal(patch.kind,'file_apply_patch');if(patch.kind==='file_apply_patch')assert.equal(patch.applied[0]!.destination,null);
 const repo={kind:'repo_status',branch:'',dirty_files:[],staged_files:[],remotes:[],ahead:0n,behind:0n};
 const value=parse(repo);assert.equal(value.kind,'repo_status');if(value.kind==='repo_status')assert.equal(value.upstream,null);
 expectKind(()=>parse({...repo,upstream:false}),'Json');
});
it('integer fields require exact Rust integer representations and signed bounds',()=>{
 const raw=serializeSerdeValue(fixtures[6]);
 for(const literal of ['9223372036854775808','-9223372036854775809','1.0','1e0','-0','null'])expectKind(()=>parseCoreOutput(raw.replace('-9223372036854775808',literal),1000),'Json');
 expectKind(()=>parse({kind:'image_list',images:[{...image,size_bytes:-1n}]}),'Json');
});
it('full structural decoding precedes code-search semantic line rejection',()=>{
 expectKind(()=>parse({kind:'code_search',matches:[{path:'',line:0n,snippet:''}]}),'Validation');
 expectKind(()=>parse({kind:'code_search',matches:[{path:'',line:0n,snippet:''},{path:'',line:1n,snippet:3n}]}),'Json');
});
it('nested arrays are immutable, UTF8 budgets are checked, and malformed wire types fail closed',()=>{
 const value=parse(fixtures[0]);if(value.kind==='project_rules'){assert.equal(Object.isFrozen(value.rules),true);assert.equal(Object.isFrozen(value.rules[0]),true);}
 expectKind(()=>parse({kind:'project_rules',rules:null}),'Json');expectKind(()=>parse({kind:'repo_diff',files:[],summary:'',patch:'',truncated:null}),'Json');
 const raw=serializeSerdeValue({kind:'git_push',remote:'',branch:'',output:'한글'});assert.throws(()=>parseCoreOutput(raw,Buffer.byteLength(raw)-1),RangeError);assert.equal(parseCoreOutput(raw,Buffer.byteLength(raw)).kind,'git_push');
});
