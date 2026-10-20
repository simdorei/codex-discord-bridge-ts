import {parentPort,workerData as q} from 'node:worker_threads';
import * as stateIdleReleaseStore from '../store/idle-release-store.ts';
import {requireDiscordText} from '../discord/text.ts';
import {passiveErrorText} from '../core/passive-error-text.ts';
const port=parentPort;if(port===null)throw new Error('Idle admission requires owned worker');
try{let value:unknown;switch(q.operation){case 'validateInstallation':{
 if(Object.keys(q).length!==3||typeof q.nonce!=='string'||!/^[-a-f0-9]{36}$/.test(q.nonce))throw new TypeError('Invalid exact idle installation request');
 stateIdleReleaseStore.pendingIdleIntentsExisting(q.path);value={operation:q.operation,path:q.path,nonce:q.nonce};break;
 }case 'before':value=stateIdleReleaseStore.beforeIdleMutationExisting(q.path,q.owner,q.generation,q.thread);break;case 'transition':value=stateIdleReleaseStore.transitionIdleIntentExisting(q.path,q.token,q.state,q.detail);break;case 'settleExitedOwner':{
 if(Object.keys(q).length!==5||typeof q.owner!=='string'||q.owner.includes('\0')||Buffer.byteLength(q.owner)>4096||typeof q.generation!=='bigint'||q.generation<0n||q.generation>=(1n<<63n)||typeof q.nonce!=='string'||!/^[-a-f0-9]{36}$/.test(q.nonce))throw new TypeError('Invalid exact idle exit request');
 requireDiscordText(q.owner);stateIdleReleaseStore.settleExitedIdleOwnerExisting(q.path,q.owner,q.generation);value={operation:q.operation,path:q.path,owner:q.owner,generation:q.generation,nonce:q.nonce};break;
 }default:throw new TypeError('Unsupported native idle operation');}port.postMessage({ok:true,value});}
catch(error){port.postMessage({ok:false,detail:Array.from(passiveErrorText(error,'Native idle admission failed')).slice(0,2048).join('')});}
finally{port.close();}
