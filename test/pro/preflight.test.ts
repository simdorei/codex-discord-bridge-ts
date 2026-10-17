import test from 'node:test';import assert from 'node:assert/strict';
import {verifyPluginInventory,verifyProRuntime,ProPreflightError,REMOTE_PLUGIN_ID,CHROME_PLUGIN_ID,type ProDiagnosticCode} from '../../src/pro/preflight.ts';
const remote=()=>({pluginId:REMOTE_PLUGIN_ID,installed:true,enabled:true,version:'1.2.3'}),browser=()=>({pluginId:CHROME_PLUGIN_ID,installed:true,enabled:true,version:'9.8.7'});
const raw=(records:unknown[]=[remote(),browser()])=>JSON.stringify({installed:records});
const resident=()=>({generation:8n,healthy:true,accepting:true,pluginRuntimeFingerprint:'fingerprint',pluginRuntimeError:null});
const code=(expected:ProDiagnosticCode)=>(error:unknown)=>{assert.ok(error instanceof ProPreflightError);assert.equal(error.diagnostic.code,expected);assert.equal(error.message,error.diagnostic.internalDetail);assert.ok(Object.isFrozen(error.diagnostic));return true;};
test('source valid plugin/runtime status and exact u64 resident generation',()=>{
 assert.deepEqual(verifyProRuntime(raw(),'1.2.3',resident(),'fingerprint'),{remotePluginVersion:'1.2.3',browserPluginVersion:'9.8.7',residentGeneration:8n});
 assert.equal(verifyProRuntime(raw(),'1.2.3',{...resident(),generation:18446744073709551615n},'fingerprint').residentGeneration,18446744073709551615n);
});
test('malformed inventory, array shape and unrelated malformed entry fail closed',()=>{
 for(const value of ['not-json','null','[]','{}','{"installed":null}',raw([remote(),browser(),null])])assert.throws(()=>verifyPluginInventory(value,'1.2.3'),code('PluginInventoryInvalid'));
 assert.deepEqual(verifyPluginInventory(raw([remote(),browser(),{other:true}]),'1.2.3'),{remoteVersion:'1.2.3',browserVersion:'9.8.7'});
});
test('required plugin exact identity and duplicate rejection precede enabled checks',()=>{
 assert.throws(()=>verifyPluginInventory(raw([browser()]),'1.2.3'),code('RemotePluginMissing'));
 assert.throws(()=>verifyPluginInventory(raw([remote(),remote(),browser()]),'1.2.3'),code('RemotePluginMissing'));
 assert.throws(()=>verifyPluginInventory(raw([{...remote(),enabled:false}]),'1.2.3'),code('BrowserPluginMissing'));
 assert.throws(()=>verifyPluginInventory(raw([remote(),browser(),browser()]),'1.2.3'),code('BrowserPluginMissing'));
 assert.throws(()=>verifyPluginInventory(raw([{...remote(),pluginId:REMOTE_PLUGIN_ID.toUpperCase()},browser()]),'1.2.3'),code('RemotePluginMissing'));
});
test('exact booleans, nonempty version and remote/browser diagnostic separation',()=>{
 for(const [index,prefix] of [[0,'Remote'],[1,'Browser']] as const){
  for(const [patch,suffix] of [[{installed:false},'NotInstalled'],[{installed:1},'NotInstalled'],[{enabled:'true'},'Disabled'],[{version:''},'VersionInvalid'],[{version:1},'VersionInvalid']] as const){const records=[remote(),browser()];records[index]={...records[index]!,...patch} as ReturnType<typeof remote>;assert.throws(()=>verifyPluginInventory(raw(records),'1.2.3'),code(`${prefix}Plugin${suffix}` as ProDiagnosticCode));}
 }
 assert.throws(()=>verifyPluginInventory(raw([{...remote(),version:'wrong'}, {...browser(),enabled:false}]),'1.2.3'),code('BrowserPluginDisabled'));
 assert.throws(()=>verifyPluginInventory(raw(),'other'),code('RemotePluginVersionMismatch'));
 assert.equal(verifyPluginInventory(raw([{...remote(),version:' '},browser()]),' ').remoteVersion,' ');
});
test('resident policy ordering preserves unhealthy, failed, missing, stale distinctions',()=>{
 assert.throws(()=>verifyProRuntime(raw(),'1.2.3',{...resident(),healthy:false,pluginRuntimeError:'broken'},'changed'),code('ResidentUnhealthy'));
 assert.throws(()=>verifyProRuntime(raw(),'1.2.3',{...resident(),accepting:false},'fingerprint'),code('ResidentUnhealthy'));
 assert.throws(()=>verifyProRuntime(raw(),'1.2.3',{...resident(),pluginRuntimeError:''},'changed'),code('ResidentSnapshotFailed'));
 assert.throws(()=>verifyProRuntime(raw(),'1.2.3',{...resident(),pluginRuntimeFingerprint:null},'changed'),code('ResidentSnapshotMissing'));
 assert.throws(()=>verifyProRuntime(raw(),'1.2.3',resident(),'changed'),code('ResidentStale'));
});
test('snapshot own-data checks never invoke getters/proxies; invalid inventory masks snapshot access',()=>{
 let calls=0;const bad={...resident(),get healthy(){calls++;return true;}};
 assert.throws(()=>verifyProRuntime(raw(),'1.2.3',bad,'fingerprint'),TypeError);
 const proxy=new Proxy(resident(),{getOwnPropertyDescriptor(){calls++;throw Error('trap');}});
 assert.throws(()=>verifyProRuntime(raw(),'1.2.3',proxy,'fingerprint'),TypeError);
 assert.throws(()=>verifyProRuntime('bad','1.2.3',bad,'fingerprint'),code('PluginInventoryInvalid'));assert.equal(calls,0);
 for(const generation of [-1n,1n<<64n,1])assert.throws(()=>verifyProRuntime(raw(),'1.2.3',{...resident(),generation:generation as bigint},'fingerprint'),TypeError);
});
test('diagnostic literal parity does not claim browser access or silently trim versions',()=>{
 assert.throws(()=>verifyPluginInventory(raw([remote()]),'1.2.3'),(error:unknown)=>{assert.ok(error instanceof ProPreflightError);assert.equal(error.diagnostic.publicMessage,'The Chrome plugin entry is missing or duplicated; Chrome availability was not tested.');assert.equal(error.diagnostic.internalDetail,"plugin 'chrome@openai-bundled' was not installed exactly once");return true;});
 assert.throws(()=>verifyPluginInventory(raw([{...remote(),version:'1.2.3 '},browser()]),'1.2.3'),code('RemotePluginVersionMismatch'));
 assert.equal(verifyProRuntime(raw(),'1.2.3',{...resident(),pluginRuntimeFingerprint:''},'').residentGeneration,8n);
});
