import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {join,dirname} from 'node:path';
import {writeFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {abandonmentStoreFixture} from '../../helpers/abandonment-store-fixture.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {classifyGatewayMessage as classify,MessageCandidate,MessageAdmissionIntegerRangeError} from '../../../src/runtime/message-worker/classification.ts';
import {MessagePlanError} from '../../../src/runtime/message-plan.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {SettingsTargetResolver} from '../../../src/runtime/settings-binding.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
const config={enableMessageContent:true,plainAskMentionUserIds:new Set<bigint>()};
const policy=new InteractionAccessPolicy({allowAllChannels:true,allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[]});
function message(content:string,extra:Record<string,unknown>={}){return decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content,edited_timestamp:null,embeds:[],id:'3',mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-02-02T02:02:02.020000+00:00',tts:false,type:0,...extra}));}
async function candidate(path:string,text:string){const c=await classify(message(text),path,config,policy,null);assert.equal(c.kind,'Candidate');if(c.kind!=='Candidate')throw Error('fixture');return c.candidate;}
async function mapping(path:string,target:string){const db=await openInitialized(path);try{db.exec('DELETE FROM mirror_threads');db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run(target,'p','title',9n,1n,1);}finally{db.close();}}
function resolver(path:string){const file=join(dirname(path),'codex.sqlite'),db=new DatabaseSync(file);try{db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER); INSERT INTO threads(id,title,cwd,updated_at,archived) VALUES('t','T','/t',10,0),('other','Other','/other',20,0)");}finally{db.close();}const bridge=new BridgeState(join(dirname(path),'bridge.json'));bridge.setSelectedThreadId('t');return new SettingsTargetResolver(file,path,bridge);}
test('authenticated policy yields independent flags and ignore creates no admitted message row',()=>storeFixture(async path=>{
 const denied=new InteractionAccessPolicy({allowAllChannels:false,allowedChannelIds:[],allowedUserIds:[99n],mirroredChannelIds:[]});
 assert.deepEqual(denied.messageAccess(message('!bad')),{channelAllowed:false,userAllowed:false});
 const result=await classify(message('!bad'),path,config,denied,null);assert.deepEqual(result,{kind:'Ignore',reason:'channel_not_allowed',channelId:1n,userId:2n});assert.equal(await state.getIngress(path,'message:3'),null);
}));
test('classification freezes malformed command as a candidate error for later durable custody',()=>storeFixture(async path=>{
 const c=await candidate(path,'!unknown');assert.equal(c.isPendingReplyCandidate(),false);const parts=c.intoAdmissionParts();assert.equal(parts.frozenPlan.ok,false);
 if(parts.frozenPlan.ok)throw Error('fixture');assert.ok(parts.frozenPlan.error instanceof MessagePlanError);assert.equal(parts.message.content,'!unknown');assert.equal(await state.getIngress(path,'message:3'),null);
 assert.throws(()=>c.intoAdmissionParts(),/consumed/);assert.throws(()=>c.isStopControl(),/consumed/);assert.throws(()=>new MessageCandidate(Symbol(),parts),TypeError);
}));
test('ordinary Ask is a pending reply candidate while Pro is not',()=>storeFixture(async path=>{
 for(const [text,expected] of [['hello',true],['!pro inspect',false],['[codex-reply:0123456789abcdef0123456789abcdef] !pro literal',true]] as const){const c=await candidate(path,text);assert.equal(c.isPendingReplyCandidate(),expected);}
 assert.equal((await candidate(path,'!stop')).isStopControl(),true);for(const text of ['!force_restart','!recover','!repair'])assert.equal((await candidate(path,text)).isForceRestart(),true);
 assert.equal((await candidate(path,'!restart_codex')).isForceRestart(),false);
}));
test('classification captures immutable original mapping and does not silently retarget',()=>storeFixture(async path=>{
 await mapping(path,'t');const c=await candidate(path,'hello');await mapping(path,'other');const p=c.intoAdmissionParts();assert.equal(p.routingTarget,'t');assert.equal(p.newOrigin.target,'t');assert.ok(Object.isFrozen(p.newOrigin));assert.ok(Object.isFrozen(p.message));
}));
test('missing mention can use only an existing original pending new-prompt arm',()=>storeFixture(async path=>{
 const cfg={enableMessageContent:true,plainAskMentionUserIds:new Set([42n])};assert.equal((await classify(message('hello'),path,cfg,policy,null)).kind,'Ignore');
 await state.admitIngress(path,{ingressId:'message:1',kind:'message',eventId:1n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:1n,payload:{version:1n,author_is_bot:false,content:'!new',plan:{Execute:{New:{prompt:''}}}},targetThreadId:null,canonicalOwner:null,now:1});
 const result=await classify(message('hello'),path,cfg,policy,null);assert.equal(result.kind,'Candidate');if(result.kind!=='Candidate')throw Error('fixture');const parts=result.candidate.intoAdmissionParts();assert.equal(parts.newPromptMentionArm,'message:1');assert.deepEqual(parts.frozenPlan,{ok:true,value:{Execute:{Ask:{prompt:'hello'}}}});assert.equal(await state.getIngress(path,'message:3'),null);
}));
test('discard classification requires owned held original job and mapping without creating a proposal',()=>abandonmentStoreFixture(async(db,path)=>{
 const job='550e8400-e29b-41d4-a716-446655440000';const c=await candidate(path,'!discard-request '+job);assert.equal(c.intoAdmissionParts().routingTarget,'t');assert.equal(db.prepare('SELECT count(*) n FROM cdr_recovery_abandonment_proposals').get()!.n,0);
 await assert.rejects(classify(message('!discard-request '+job,{author:{id:'8',username:'u',discriminator:'0',bot:false}}),path,config,policy,null));
},true,'550e8400-e29b-41d4-a716-446655440000'));
test('settings mapping race becomes frozen Respond instead of update or retarget',()=>storeFixture(async path=>{
 await mapping(path,'t');const c=await candidate(path,'!settings --model x'),r=resolver(path);await mapping(path,'other');await c.bindSettings(r);const p=c.intoAdmissionParts();assert.equal(p.settingsBinding,null);assert.deepEqual(p.frozenPlan,{ok:true,value:{Respond:'ERROR: settings mapping changed during message classification; no update was sent'}});
}));
test('lifecycle mapping race freezes separate rejection before settings mutation binding',()=>storeFixture(async path=>{
 await mapping(path,'t');const c=await candidate(path,'!stop'),r=resolver(path);await mapping(path,'other');await c.bindSettings(r);const p=c.intoAdmissionParts();assert.equal(p.lifecycleBinding,null);assert.deepEqual(p.frozenPlan,{ok:true,value:{Respond:'ERROR: lifecycle mapping changed during admission; no lifecycle operation was sent'}});
}));
test('explicit lifecycle target stays explicit and borrowed candidate cannot be consumed mid-bind',()=>storeFixture(async path=>{
 await mapping(path,'t');const c=await candidate(path,'!stop other'),r=resolver(path),pending=c.bindSettings(r);assert.throws(()=>c.intoAdmissionParts(),/borrowed/);assert.throws(()=>c.isPendingReplyCandidate(),/borrowed/);await pending;
 const p=c.intoAdmissionParts();assert.equal(p.lifecycleBinding!.target,'other');assert.equal(p.lifecycleBinding!.route,'Explicit');assert.equal(p.routingTarget,'t');
}));
test('input reference rejection is frozen while actual state database failures remain fatal',()=>storeFixture(async path=>{
 const r=resolver(path);let c=await candidate(path,'!settings missing --model x');await c.bindSettings(r);const p=c.intoAdmissionParts();assert.ok(p.frozenPlan.ok&&'Respond'in p.frozenPlan.value);assert.match((p.frozenPlan as any).value.Respond,/Thread not found/);
 c=await candidate(path,'!stop');writeFileSync(join(dirname(path),'codex.sqlite'),'not SQLite');await assert.rejects(c.bindSettings(r));
}));
test('typed message and config boundaries reject hooks and integer overflow without admitting',()=>storeFixture(async path=>{
 let hooks=0;const proxy=new Proxy(message('hello'),{get(){hooks++;throw Error('hook');}});await assert.rejects(classify(proxy,path,config,policy,null),TypeError);
 await assert.rejects(classify(message('hello',{id:String(1n<<63n)}),path,config,policy,null),MessageAdmissionIntegerRangeError);
 const cfg:any={enableMessageContent:true};Object.defineProperty(cfg,'plainAskMentionUserIds',{get(){hooks++;return new Set();}});await assert.rejects(classify(message('hi'),path,cfg,policy,null),TypeError);assert.equal(hooks,0);assert.equal(await state.getIngress(path,'message:3'),null);
}));
test('config mention set is captured before asynchronous origin lookup',()=>storeFixture(async path=>{
 const ids=new Set([42n]),pending=classify(message('hello'),path,{enableMessageContent:true,plainAskMentionUserIds:ids},policy,null);ids.clear();assert.equal((await pending).kind,'Ignore');
}));
