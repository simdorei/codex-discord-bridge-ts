import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {dirname,join} from 'node:path';import {mkdirSync,writeFileSync,chmodSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {prepareRuntimeProContext,type RuntimeProStartupContextOptions} from '../../../src/runtime/discord-runtime/startup-context.ts';import {AdmissionGate} from '../../../src/admission/drain-gate.ts';import {REMOTE_PLUGIN_ID,CHROME_PLUGIN_ID,type ProRuntimeDiagnostic} from '../../../src/pro/preflight.ts';import {PromptPreprocessError} from '../../../src/pro/project.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
const render=(e:unknown)=>e instanceof Error?e.message:'opaque';
function fixtureInput(mirrorDb:string,seedIntake=false){const root=dirname(mirrorDb),stateDb=join(root,'state.sqlite'),project=join(root,'original-project');mkdirSync(project);const db=new DatabaseSync(stateDb);try{db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');db.prepare("INSERT INTO threads(id,cwd,archived) VALUES('original',?,0)").run(project);}finally{db.close();}
 const plugin=join(root,'remote-plugin'),chrome=join(root,'chrome-plugin');mkdirSync(plugin);mkdirSync(chrome);writeFileSync(join(plugin,'plugin.json'),'remote');writeFileSync(join(chrome,'plugin.json'),'chrome');const manifest=join(root,'plugins/codex-discord-remote/.codex-plugin');mkdirSync(manifest,{recursive:true});writeFileSync(join(manifest,'plugin.json'),'{"version":"1"}');
 const inventory=JSON.stringify({installed:[{pluginId:REMOTE_PLUGIN_ID,installed:true,enabled:true,version:'1',source:{path:plugin}},{pluginId:CHROME_PLUGIN_ID,installed:true,enabled:true,version:'2',source:{path:chrome}}]});
 const executable=join(root,'codex-fixture'),failInventory=join(root,'fail-inventory'),captureLog=join(root,'capture.log'),rpcLog=join(root,'rpc.log');
 const inventoryScript=`const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite');if(fs.existsSync(${JSON.stringify(failInventory)}))process.exit(1);const db=new DatabaseSync(${JSON.stringify(mirrorDb)});const n=db.prepare('SELECT COUNT(*) AS n FROM cdr_async_recovery_policies').get().n;const first=!fs.existsSync(${JSON.stringify(captureLog)});fs.appendFileSync(${JSON.stringify(captureLog)},n+'\\n');${seedIntake?`if(first)db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at)VALUES('pro-intake','original',1,2,'!pro inspect',1,0,1,1)");`:''}db.close();process.stdout.write(${JSON.stringify(inventory)});\n`;
 const native=`const fs=require('node:fs'),readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);fs.appendFileSync(${JSON.stringify(rpcLog)},m.method+'\\n');if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});`;
 writeFileSync(executable,`#!${process.execPath}\nif(process.argv[2]==='plugin'){${inventoryScript}}else{${native}}\n`);chmodSync(executable,0o700);
 const reports:ProRuntimeDiagnostic[]=[];
 const options:RuntimeProStartupContextOptions={paths:{root,stateDb,mirrorDb,bridgeState:join(root,'bridge.json')},process:{process:{executable,arguments:['app-server','--stdio'],environment:{}},clientInfo:{name:'pro-startup',title:'fixture',version:'1'}},runtimeId:'runtime',startupChannel:null,admission:new AdmissionGate(),executor:{render,mirror:null,reportNewAttempt:()=>{},reportPolicyFailure:()=>{},notifyDeliveryReady:()=>{},resumeTimeoutMs:1000,historyTimeoutMs:1000,pro:{executable,remote:{deviceId:'original-device',isConnected:()=>true},report:d=>{reports.push(d);}}},access:{allowedChannelIds:new Set([1n]),allowedUserIds:new Set([2n]),allowAllChannels:false},reserveLimits:{maxRows:128,maxBytes:1048576},policyLimits:{maxRows:100n,maxValueBytes:65536n,maxOutputIds:200,timeoutMs:5000},storageTimeoutMs:5000};
 return {options,reports,project,executable,failInventory,captureLog,rpcLog};
}

test('real Pro startup captures installed files after queue policy and binds original project preprocessing',async()=>storeFixture(async path=>{
 const f=fixtureInput(path),result=await prepareRuntimeProContext(f.options);try{assert.ok(result.pro);assert.equal(readFileSync(f.captureLog,'utf8'),'1\n');assert.equal(await result.pro.prepare('ordinary  ','original'),'ordinary  ');assert.equal(readFileSync(f.captureLog,'utf8'),'1\n');const prompt=await result.pro.prepare('!pro inspect','original');assert.match(prompt,/original-device/);assert.ok(prompt.includes(f.project));assert.equal(f.reports.length,0);assert.equal(result.owner.instanceId,result.backend.residentInstanceId());}finally{await result.disposeBeforeWorkers();}
}));

test('startup intake uses actual Pro preprocessor and saves a missing-remote error without raw turn dispatch',async()=>storeFixture(async path=>{
 const f=fixtureInput(path,true);f.options={...f.options,executor:{...f.options.executor,pro:{...f.options.executor.pro,remote:null}}};const result=await prepareRuntimeProContext(f.options);
 try{assert.equal(result.intakes.recovered,0);assert.equal(f.reports.at(-1)?.code,'RemoteMcpNotConfigured');const saved=await state.getPromptIntake(path,'pro-intake');assert.equal(saved?.rawPrompt,'!pro inspect');assert.match(saved?.lastError??'',/not configured/);assert.ok(saved!.retryAfter>0);assert.equal(readFileSync(f.captureLog,'utf8'),'1\n1\n');assert.doesNotMatch(readFileSync(f.rpcLog,'utf8'),/turn\/start/);const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_turn_queue').get()!.n,0);}finally{db.close();}}finally{await result.disposeBeforeWorkers();}
}));

test('failed initial plugin capture permits ordinary text but !pro remains a verified preflight failure',async()=>storeFixture(async path=>{
 const f=fixtureInput(path);writeFileSync(f.failInventory,'fail');const result=await prepareRuntimeProContext(f.options);try{assert.ok(result.pro);assert.equal(await result.pro.prepare('plain','original'),'plain');await assert.rejects(result.pro.prepare('!pro inspect','original'),PromptPreprocessError);assert.equal(f.reports.at(-1)?.code,'PluginInventoryQueryFailed');}finally{await result.disposeBeforeWorkers();}
}));

test('Pro executable, remote identity and callback references are captured before foundation awaits',async()=>storeFixture(async path=>{
 const f=fixtureInput(path),remote={deviceId:'original-device',isConnected:()=>true};f.options={...f.options,executor:{...f.options.executor,pro:{...f.options.executor.pro,remote}}};const pending=prepareRuntimeProContext(f.options);remote.deviceId='wrong-device';remote.isConnected=()=>false;Object.assign(f.options.executor.pro,{executable:'/missing',report:()=>assert.fail('changed diagnostic')});const result=await pending;try{assert.ok(result.pro);assert.match(await result.pro.prepare('!pro inspect','original'),/original-device/);}finally{await result.disposeBeforeWorkers();}
}));

test('accessor Pro readiness is rejected without executing hooks, launching children or creating bridge store',async()=>storeFixture(async path=>{
 const f=fixtureInput(path);let hooks=0;const remote=Object.defineProperty({deviceId:'device'},'isConnected',{get(){hooks++;return ()=>true;}});f.options={...f.options,executor:{...f.options.executor,pro:{...f.options.executor.pro,remote:remote as never}}};await assert.rejects(prepareRuntimeProContext(f.options),TypeError);assert.equal(hooks,0);assert.equal(existsSync(path),false);assert.equal(existsSync(f.captureLog),false);assert.equal(existsSync(f.rpcLog),false);
}));


test('Pro inventory executable mismatch rejects before native launch and bridge mutations',async()=>storeFixture(async path=>{
 const f=fixtureInput(path);f.options={...f.options,executor:{...f.options.executor,pro:{...f.options.executor.pro,executable:join(f.options.paths.root,'foreign-codex')}}};
 let unexpected:Awaited<ReturnType<typeof prepareRuntimeProContext>>|undefined;
 try{await assert.rejects(prepareRuntimeProContext(f.options).then(v=>{unexpected=v;return v;}),/same executable/);}finally{await unexpected?.disposeBeforeWorkers();}
 assert.equal(existsSync(path),false);assert.equal(existsSync(f.rpcLog),false);assert.equal(existsSync(f.captureLog),false);
}));
