#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {prepareMaintenanceStartup} from './maintenance.ts';
import {RuntimeStopSignal} from '../runtime/discord-runtime/stop-signal.ts';
import {runLocalRuntimeApplication,LocalRuntimeUnsupportedError,LocalRuntimeOwnershipRetainedError} from '../runtime/discord-runtime/local-application.ts';
/** Experimental local profile. No production readiness or full parity claim. */
try{
 if(process.versions.node.split('.')[0]!=='24')throw new Error('Node24 required');
 const env=new Map<string,string>();for(const [key,value] of Object.entries(process.env))if(value!==undefined)env.set(key,value);
 const stop=RuntimeStopSignal.install();let prepared;
 try{prepared=await prepareMaintenanceStartup(process.argv.slice(2),env,fileURLToPath(import.meta.url),process.cwd(),'0.0.0',stop.signal);}finally{stop.dispose();}
 if(prepared.kind==='output')process.stdout.write(prepared.text+'\n');
 else if(prepared.kind==='admin'){process.stderr.write('local_runtime_unsupported_admin\n');process.exitCode=2;}
 else{
  const environment:Record<string,string>=Object.create(null);Map.prototype.forEach.call(prepared.environment,(value:string,key:string)=>{Object.defineProperty(environment,key,{value,enumerable:true});});
  await runLocalRuntimeApplication(prepared.config,environment,process.cwd(),'0.0.0');
 }
}catch(error){
 if(error instanceof LocalRuntimeUnsupportedError){process.stderr.write('local_runtime_unsupported_profile: remote, session mirror, host commands and Windows are not connected by this entry\n');process.exitCode=2;}
 else if(error instanceof LocalRuntimeOwnershipRetainedError){process.stderr.write('local_runtime_ownership_retained: cleanup unconfirmed; do not restart\n');process.exitCode=1;}
 else{process.stderr.write('local_runtime_failed: no confirmed result; inspect durable evidence before retrying\n');process.exitCode=1;}
}
