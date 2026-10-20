import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {storeFixture} from '../helpers/store-fixture.ts';
import {verifyCachebuster,classifyReleaseTests,collectReleaseEvidence,type ReleaseRunner} from '../../src/pro/release-tools.ts';
test('cachebuster rejects payload changes without a newer version and validates calendar timestamps',()=>storeFixture(async path=>{
 const root=dirname(path),manifest=join(root,'plugins/codex-discord-remote/.codex-plugin/plugin.json');await mkdir(dirname(manifest),{recursive:true});
 const runner:ReleaseRunner=async(_exe,args)=>({code:0,stdout:args.includes('show')?'{"version":"0.1.0+codex.20261018170000"}':args.includes('diff')?'src/pro/helper/main.ts\0':args.includes('ls-files')?'':'a'.repeat(40)});
 await writeFile(manifest,'{"version":"0.1.0+codex.20261018170000"}');await assert.rejects(verifyCachebuster(root,'HEAD',true,runner),/increasing/);
 await writeFile(manifest,'{"version":"0.1.0+codex.20261018180000"}');assert.match(await verifyCachebuster(root,'HEAD',true,runner),/passed/);
 await writeFile(manifest,'{"version":"0.1.0+codex.20260230180000"}');await assert.rejects(verifyCachebuster(root,'HEAD',true,runner),/timestamp/);
}));
test('release evidence cannot treat zero/filtered/skipped tests or failed installed checks as a release',()=>storeFixture(async path=>{
 const valid='# tests 4\n# pass 4\n# fail 0\n# skipped 0\n';assert.equal(classifyReleaseTests({code:0,stdout:valid}),'passed');assert.equal(classifyReleaseTests({code:0,stdout:''}),'malformed');assert.equal(classifyReleaseTests({code:0,stdout:valid.replace('# skipped 0','# skipped 1')}),'malformed');
 const root=dirname(path),manifest=join(root,'plugins/codex-discord-remote/.codex-plugin/plugin.json');await mkdir(dirname(manifest),{recursive:true});await writeFile(manifest,'{"version":"0.1.0+codex.20261018180000"}');
 const runner:ReleaseRunner=async(exe,args)=>{if(exe==='git')return{code:0,stdout:args.includes('rev-parse')?'a'.repeat(40):''};if(exe==='fixture-codex')return{code:1,stdout:''};return{code:0,stdout:valid};};
 const result=await collectReleaseEvidence(root,'fixture-codex',join(root,'evidence.json'),runner,async()=>{throw Error('unavailable');});assert.equal(result.pre_restart_ready,false);assert.equal(result.release_ready,false);assert.equal(result.checks.find(c=>c.id==='fresh_resident_preflight')?.status,'failed');assert.equal(result.checks.find(c=>c.id==='installed_plugin_inventory')?.status,'failed');
}));
