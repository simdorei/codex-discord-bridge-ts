import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {NewReplyObserver} from '../../../src/runtime/new-reply/observation.ts';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const identity=()=>({threadId:'thread',cwd:'C:/project',turnId:'first-turn',promptSha256:'be41aba2fd84362ba49d22d8635d6c05f86426ee40846f1354e944062c4557a8'});
const meta=()=>({type:'session_meta',payload:{id:'thread',cwd:'C:/project'}}),turn=(id:unknown='first-turn')=>({type:'turn_context',payload:{turn_id:id}}),user=(text='요청',role='user')=>({type:'response_item',payload:{role,content:[{text}]}});
test('exact original turn user input required; same text in later turn or assistant content never verifies',()=>{
 for(const [id,role,text,expected] of [['first-turn','user','요청',true],['later-turn','user','요청',false],['first-turn','assistant','요청',false],['first-turn','user','다른 요청',false]] as const){const o=new NewReplyObserver(identity());assert.equal(o.observe(meta()),false);assert.equal(o.observe(turn(id)),false);assert.equal(o.observe(user(text,role)),expected);}
 for(const prefix of [[],[meta()],[turn()]]){const o=new NewReplyObserver(identity());for(const e of prefix)o.observe(e);assert.equal(o.observe(user()),false);}
});
test('thread and project mismatch fail without updating previous observation state',()=>{
 for(const key of ['id','cwd'] as const){const o=new NewReplyObserver(identity()),event=meta();event.payload[key]='wrong';const before=o.snapshot();assert.throws(()=>o.observe(event),/thread\/project identity mismatch/);assert.equal(o.snapshot(),before);}
 const o=new NewReplyObserver({...identity(),cwd:'/project/a/../b'});o.observe({type:'session_meta',payload:{id:'thread',cwd:'/project/b/'}});o.observe(turn());assert.equal(o.observe(user()),true);
});
test('task-start and task-complete transition exact turn; invalid context clears prior turn',()=>{
 const o=new NewReplyObserver(identity());o.observe(meta());o.observe({type:'event_msg',payload:{type:'task_started',turn_id:'first-turn'}});o.observe({type:'event_msg',payload:{type:'task_complete'}});assert.equal(o.observe(user()),false);o.observe(turn());o.observe(turn(12n));assert.equal(o.observe(user()),false);o.observe({type:'event_msg',payload:{type:'task_started',turn_id:'first-turn'}});assert.equal(o.observe({type:'event_msg',payload:{type:'user_message',message:'요청'}}),true);
});
test('response content concatenates only strings with no separator and accepts exact empty source text',()=>{
 const o=new NewReplyObserver(identity());o.observe(meta());o.observe(turn());assert.equal(o.observe({type:'response_item',payload:{role:'user',content:[{text:'요'},null,{text:1n},{other:'ignored'},{text:'청'}]}}),true);
 const e=new NewReplyObserver({...identity(),promptSha256:digest('')});e.observe(meta());e.observe(turn());assert.equal(e.observe({type:'response_item',payload:{role:'user',content:[]}}),true);
});
test('snapshot state is immutable, restorable across complete windows, and matching stops further observation',()=>{
 const input=identity(),o=new NewReplyObserver(input);input.threadId='changed';o.observe(meta());o.observe(turn());const snapshot=o.snapshot();assert.equal(Object.isFrozen(snapshot),true);const resumed=new NewReplyObserver(identity(),snapshot);assert.equal(resumed.observe(user()),true);assert.equal(resumed.observe({type:'session_meta',payload:{id:'different',cwd:'else'}}),true);assert.equal(o.snapshot().matched,false);
});
test('null original turn, wrong digest casing, missing payload and primitive JSON do not accidentally match',()=>{
 for(const id of [{...identity(),turnId:null},{...identity(),promptSha256:identity().promptSha256.toUpperCase()}]){const o=new NewReplyObserver(id);o.observe(meta());o.observe(turn());assert.equal(o.observe(user()),false);}
 const o=new NewReplyObserver(identity());for(const e of [null,1n,'value',[],{type:'session_meta'},{type:'response_item',payload:null}])assert.equal(o.observe(e),false);
});
test('bounded event profile and passive identity/state validation reject hostile hooks before execution',()=>{
 const o=new NewReplyObserver(identity());let hooks=0;const hostile=Object.defineProperty({},'payload',{enumerable:true,get(){hooks++;return {};}});assert.throws(()=>o.observe(hostile));assert.throws(()=>o.observe(new Proxy({}, {get(){hooks++;return undefined;}})));assert.equal(hooks,0);assert.throws(()=>o.observe({payload:'x'.repeat(262144)}),RangeError);
 assert.throws(()=>new NewReplyObserver({...identity(),threadId:'x'.repeat(16385)}),RangeError);assert.throws(()=>new NewReplyObserver(identity(),{sessionSeen:true,turn:1,matched:false} as never),TypeError);
});

test('oversized foreign turn cannot create an unresumable cursor and leaves prior state intact',()=>{const o=new NewReplyObserver(identity());o.observe(meta());const before=o.snapshot();assert.throws(()=>o.observe(turn('x'.repeat(16385))),RangeError);assert.equal(o.snapshot(),before);assert.deepEqual(new NewReplyObserver(identity(),before).snapshot(),before);});
