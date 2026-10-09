import assert from 'node:assert/strict';
import {storeFixture} from './store-fixture.ts';
import {queueJob} from './queue-job.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {PortableResidentLifecycle} from '../../src/app-server/portable-resident-lifecycle.ts';
import type {PendingServerRequest} from '../../src/app-server/server-request-state.ts';
export async function callPromptFixture(owner: PortableResidentLifecycle, method: string, params: unknown = {}) {const a = owner.admitRequest(); try {return await a.client.requestAdmitted(a.permit, method, params, 2000);} finally {a.release();}}
export async function editPromptFixture(path: string, sql: string) {const db = await openInitialized(path); try {db.exec(sql);} finally {db.close();}}
export async function promptFixture(run: (path: string, server: PortableResidentLifecycle, request: PendingServerRequest) => Promise<void>, input: {method?: string; params?: unknown; enableResponses?: boolean; controlFailure?: boolean} = {}) {
  await storeFixture(async path => {
    const code = `import readline from 'node:readline';const answers=[],controls=[];let controlFailure=false;const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{const m=JSON.parse(line);if(m.method===undefined&&m.id==='approval'){answers.push(m);return;}if(m.method==='controls')emit({id:m.id,result:controls});else if(m.method==='turn/steer'||m.method==='turn/interrupt'){controls.push({method:m.method,params:m.params});if(controlFailure)emit({id:m.id,error:{code:-7,message:'control fixture rejected'}});else emit({id:m.id,result:{}});}else if(m.method==='answers')emit({id:m.id,result:answers});else if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='arm'){controlFailure=m.params.controlFailure===true;emit({method:'turn/started',params:{threadId:'t',turnId:'v'}});emit({id:'approval',method:m.params.method??'item/commandExecution/requestApproval',params:m.params.params??{threadId:'t',turnId:'v',reason:'fixture'}});emit({id:m.id,result:{}});}else if(m.method==='next'){emit({method:'turn/started',params:{threadId:'t',turnId:'v2'}});emit({id:m.id,result:{}});}else if(m.method==='finish'){emit({method:'turn/completed',params:{threadId:'t',turnId:'v'}});emit({id:m.id,result:{}});}});`;
    const server = await PortableResidentLifecycle.start({process: {executable: process.execPath, arguments: ['--input-type=module', '-e', code], environment: {}},
      clientInfo: {name: 'authority-fixture', title: 'Fixture', version: '0.1.0'}}, () => 'safe fixture', {persistDeadWork() {}, oldChildExited() {}}, undefined, input.enableResponses ? {fence: null, renderError: () => 'fixture response error'} : null);
    try {
      await callPromptFixture(server, 'arm', input); const pending = server.pendingServerRequests('t'); assert.equal(pending.length, 1);
      await state.enqueue(path, queueJob({jobId: 'job', targetThreadId: 't', channelId: 1n, ownerUserId: 2n}));
      await editPromptFixture(path, "UPDATE codex_turn_queue SET state='running',turn_id='v'; INSERT INTO mirror_threads VALUES ('t','p','T',10,1,1)");
      await run(path, server, pending[0]!);
    } finally {await server.dispose(); assert.equal(server.lifecycleSnapshot().healthy, false);}
  });
}
