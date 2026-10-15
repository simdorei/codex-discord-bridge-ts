import {types} from 'node:util';
import {RemoteProjectDispatcher,type RemoteDispatcherConnection} from './project-dispatcher.ts';
import type {RemoteDispatcherPorts} from './native-connection.ts';
const activeAttempts=new WeakMap<RemoteProjectDispatcher,object>();

/** One attempt's exact dispatcher receipt. Never manufacture authority from the
 * wire generation or read another attempt's current receipt. The caller retains
 * this adapter until connectAndServeRemote has also disposed its actual socket. */
export function createRemoteDispatcherConnection(dispatcher:RemoteProjectDispatcher,generation:bigint):RemoteDispatcherPorts{
 if(types.isProxy(dispatcher))throw new TypeError('Expected owned project dispatcher');
 RemoteProjectDispatcher.prototype.snapshot.call(dispatcher);
 if(typeof generation!=='bigint'||generation<0n||generation>18446744073709551615n)throw new RangeError('Invalid remote generation');
 let begun=false,retiring=false,connection:RemoteDispatcherConnection|null=null;
 const attempt=Object.freeze({});
 let beginning:Promise<void>|null=null,retirement:Promise<void>|null=null;
 return Object.freeze({
  beginConnection:(next:bigint):Promise<void>=>{
   if(next!==generation||begun||retiring)return Promise.reject(new TypeError('Remote connection attempt already claimed or generation differs'));
   begun=true;
   if(activeAttempts.has(dispatcher))return beginning=Promise.reject(new TypeError('Project dispatcher connection attempt already owned'));
   activeAttempts.set(dispatcher,attempt);
   beginning=RemoteProjectDispatcher.prototype.beginConnection.call(dispatcher,generation).then(receipt=>{connection=receipt;},error=>{if(activeAttempts.get(dispatcher)===attempt)activeAttempts.delete(dispatcher);throw error;});
   return beginning;
  },
  execute:(command,next,cancelled)=>{
   if(next!==generation||connection===null||retiring)return Promise.reject(new TypeError('Remote connection attempt has no active dispatcher receipt'));
   return RemoteProjectDispatcher.prototype.execute.call(dispatcher,command,connection,cancelled);
  },
  retireSessions:():Promise<void>=>{
   if(retirement!==null)return retirement;
   retiring=true;
   retirement=Promise.resolve().then(async()=>{
    // serveRemoteConnection retires even if begin failed. Only our successfully
    // minted receipt may be retired; another attempt must remain untouched.
    if(beginning!==null)try{await beginning;}catch{return;}
    if(connection!==null)await RemoteProjectDispatcher.prototype.retireConnection.call(dispatcher,connection);
    if(activeAttempts.get(dispatcher)===attempt)activeAttempts.delete(dispatcher);
   });
   return retirement;
  }
 });
}
