import {parentPort,workerData as q} from 'node:worker_threads';
import {statSync} from 'node:fs';
import {CodexThreadStore} from '../../codex-state/store.ts';
import {openInitialized} from '../../store/owned-driver.ts';
const port=parentPort;if(port===null)throw new Error('Storage preparation requires an owned native worker');
let stage:'Codex'|'Bridge'='Codex';
try{
 // The source probes an existing Codex DB before creating/migrating bridge state.
 // It does not validate Codex's complete schema or materialize its thread list.
 CodexThreadStore.open(q.stateDb);
 const state=statSync(q.stateDb,{bigint:true});
 let bridge;try{bridge=statSync(q.mirrorDb,{bigint:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(bridge!==undefined&&state.dev===bridge.dev&&state.ino===bridge.ino)throw new TypeError('Codex state and bridge store must be different files');
 stage='Bridge';const db=await openInitialized(q.mirrorDb);try{if(db.isTransaction)throw new Error('Initialized bridge retained an active transaction');}finally{db.close();}
 port.postMessage({ok:true});
}catch(error){port.postMessage({ok:false,stage,detail:[...(error instanceof Error?error.message:'Storage preparation failed')].slice(0,2048).join('')});}
finally{port.close();}
