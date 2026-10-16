import {parentPort,workerData} from 'node:worker_threads';
import {capturePersistentResidentBootstrapData,requirePersistentResidentRole,persistentResidentFrame,PERSISTENT_RESIDENT_HANDSHAKE_MS} from './persistent-resident-bootstrap.ts';

// Preparation only. No resident, database, native service or child is started.
requirePersistentResidentRole();
capturePersistentResidentBootstrapData(workerData);
if(parentPort===null)throw new TypeError('Persistent preparation requires original parent port');
const port=parentPort;
const timer=setTimeout(()=>{port.close();throw new Error('Persistent preparation handshake timed out');},PERSISTENT_RESIDENT_HANDSHAKE_MS);
let closed=false;
port.on('message',(message:unknown)=>{
 if(closed||!persistentResidentFrame(message,'close-unstarted')){clearTimeout(timer);port.close();throw new TypeError('Invalid persistent preparation command');}
 closed=true;clearTimeout(timer);port.postMessage({version:1,kind:'unstarted-closed'});port.close();
});
port.on('messageerror',()=>{clearTimeout(timer);port.close();throw new TypeError('Invalid persistent preparation message');});
port.postMessage({version:1,kind:'role-ready'});
