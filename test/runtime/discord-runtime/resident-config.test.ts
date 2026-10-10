import test from 'node:test';import assert from 'node:assert/strict';
import {runtimeResidentConfig} from '../../../src/runtime/discord-runtime/resident-config.ts';
test('resolved paths become literal executable and CODEX_HOME with exact stdio arguments',()=>{
 const c=runtimeResidentConfig({codexExe:'/path with spaces/codex',codexHome:'/home/한😀'},'0.0.0');
 assert.equal(c.process.executable,'/path with spaces/codex');assert.deepEqual(c.process.arguments,['app-server','--stdio']);assert.equal(c.process.environment.CODEX_HOME,'/home/한😀');
 assert.deepEqual(c.clientInfo,{name:'codex-discord-remote',title:'Codex Discord Remote',version:'0.0.0'});assert.deepEqual(Object.keys(c.process.environment),['CODEX_HOME']);
});
test('configuration is deeply frozen and detached from caller path mutation',()=>{
 const paths={codexExe:'C:\\codex.exe',codexHome:'C:\\home'},c=runtimeResidentConfig(paths,'test-version');paths.codexExe='other';paths.codexHome='other';
 assert.equal(c.process.executable,'C:\\codex.exe');assert.equal(c.process.environment.CODEX_HOME,'C:\\home');for(const x of [c,c.process,c.process.arguments,c.process.environment,c.clientInfo])assert.equal(Object.isFrozen(x),true);
 assert.equal(Object.getPrototypeOf(c.process.environment),null);
});
test('path accessors, inherited values and proxies are rejected without execution',()=>{
 let calls=0;assert.throws(()=>runtimeResidentConfig({get codexExe(){calls++;return 'bad';},codexHome:'home'},'v'));assert.equal(calls,0);
 assert.throws(()=>runtimeResidentConfig(Object.create({codexExe:'exe',codexHome:'home'}),'v'));
 assert.throws(()=>runtimeResidentConfig(new Proxy({codexExe:'exe',codexHome:'home'},{get(){calls++;throw Error('trap');},getOwnPropertyDescriptor(){calls++;throw Error('trap');}}),'v'));assert.equal(calls,0);
});
test('ill-formed and NUL text fails before any native spawn; empty source strings remain representable',()=>{
 for(const bad of ['\ud800','x\0y']){assert.throws(()=>runtimeResidentConfig({codexExe:bad,codexHome:'home'},'v'));assert.throws(()=>runtimeResidentConfig({codexExe:'exe',codexHome:bad},'v'));assert.throws(()=>runtimeResidentConfig({codexExe:'exe',codexHome:'home'},bad));}
 const c=runtimeResidentConfig({codexExe:'',codexHome:''},'');assert.equal(c.process.environment.CODEX_HOME,'');
});
