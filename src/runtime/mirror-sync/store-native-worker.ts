import {parentPort,workerData as data} from 'node:worker_threads';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import {RoomCleanupProtectedError} from '../../store/room-cleanup.ts';
import {normalizeWorkspacePath} from '../../codex-state/thread-reference.ts';
import {captureMirrorStoreRequest} from './store-native-protocol.ts';
const port=parentPort;if(port===null)throw new Error('Owned mirror store worker required');
const binding={id:data.id,path:data.path,kind:data.operation.kind};
const matches=(a:string,b:string)=>a===b||normalizeWorkspacePath(a)===normalizeWorkspacePath(b);
try{

 const q=captureMirrorStoreRequest(data.operation);let value:unknown=null;
 switch(q.kind){
  case 'MirrorTargets':value=await state.mirrorTargets(data.path,(1n<<63n)-1n);break;
  case 'RemainingIds':value=await state.remainingDiscordIds(data.path);break;
  case 'IsMapped':value=await state.isMirrorChannelMapped(data.path,...q.args);break;
  case 'ThreadChannels':value=await state.mirrorThreadChannels(data.path,...q.args);break;
  case 'ConfirmedThreadCreation':value=await state.confirmedMirrorCreation(data.path,...q.args);break;
  case 'BeginThreadCreation':value=await state.beginMirrorCreation(data.path,...q.args);break;
  case 'ConfirmThreadCreation':await state.confirmMirrorCreation(data.path,...q.args);break;
  case 'CommitThread':await state.commitThreadSync(data.path,...q.args);break;
  case 'StaleThreads':value=await state.staleMirrorThreads(data.path,...q.args);break;
  case 'StaleProjects':value=await state.staleMirrorProjects(data.path,...q.args);break;
  case 'RetireThread':value=await state.retireMirrorThreadSync(data.path,...q.args);break;
  case 'RetireProject':value=await state.retireMirrorProjectSync(data.path,...q.args);break;
  case 'CategoryReceipt':value=await state.mirrorCategoryReceipt(data.path,...q.args);break;
  case 'BeginCategory':value=await state.beginMirrorCategory(data.path,...q.args);break;
  case 'ConfirmContainer':value=await state.confirmMirrorContainer(data.path,...q.args);break;
  case 'BindCategory':await state.bindMirrorCategory(data.path,...q.args);break;
  case 'FindProject':value=await state.findMirrorProject(data.path,...q.args,matches);break;
  case 'ProjectForChannel':value=await state.mirrorProjectForChannel(data.path,...q.args);break;
  case 'ProjectSnapshot':value=await state.mirrorProjectSnapshot(data.path,...q.args,matches);break;
  case 'ProjectReceipt':value=await state.mirrorProjectCreationReceipt(data.path,...q.args,matches);break;
  case 'BeginProject':value=await state.beginMirrorProject(data.path,...q.args,matches);break;
  case 'ProjectAdoptable':await state.ensureMirrorProjectAdoptable(data.path,...q.args);break;
  case 'UpsertProject':value=await state.upsertMirrorProject(data.path,...q.args,matches);break;
  case 'CleanupOwnsToken':value=await state.roomCleanupOwnsToken(data.path,...q.args);break;
  case 'BeginCleanup':value=await state.beginRoomCleanup(data.path,...q.args);break;
  case 'CompleteCleanup':await state.completeRoomCleanup(data.path,...q.args);break;
  case 'ReleaseCleanup':await state.releaseRejectedRoomCleanup(data.path,...q.args);break;
  case 'CleanupPhase':value=await state.roomCleanupPhase(data.path,...q.args);break;
  case 'CleanupConfirmed':value=await state.roomCleanupConfirmedTarget(data.path,...q.args);break;
  case 'UnconfirmedCleanup':value=await state.unconfirmedRoomCleanupChannels(data.path);break;
  case 'CleanupPending':value=state.roomCleanupPendingReasonReadonly(data.path,...q.args);break;
 }
 port.postMessage({...binding,ok:true,value});
}catch(error){
 // This tag exists only for a normal begin which rolled back before returning.
 // No arbitrary exception string is promoted to a no-effect proof.
 if(data.operation.kind==='BeginCleanup'&&error instanceof RoomCleanupProtectedError)port.postMessage({...binding,ok:false,protected:{channel:error.channel,reason:error.reason}});
 else port.postMessage({...binding,ok:false});
}finally{port.close();}
