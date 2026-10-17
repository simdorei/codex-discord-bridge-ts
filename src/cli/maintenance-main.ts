#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {prepareMaintenanceStartup} from './maintenance.ts';
/** Executable maintenance entry only. Never starts a gateway or silently accepts
 * an unsupported admin plan. Deployment/runtime assembly remains separate. */
const shutdown=new AbortController();
const stop=()=>shutdown.abort(new Error('Maintenance interrupted; inspect durable evidence before retry'));
process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
 if(process.versions.node.split('.')[0]!=='24')throw new Error('Node24 required');
 const environment=new Map<string,string>();for(const [key,value] of Object.entries(process.env))if(value!==undefined)environment.set(key,value);
 const result=await prepareMaintenanceStartup(process.argv.slice(2),environment,fileURLToPath(import.meta.url),process.cwd(),'0.0.0-migration',shutdown.signal);
 if(result.kind!=='output'){
  process.stderr.write('maintenance_unsupported: gateway startup and this admin operation are not enabled by this entry point\n');process.exitCode=2;
 }else{shutdown.signal.throwIfAborted();process.stdout.write(result.text+'\n');}
}catch{
 // Do not print arbitrary causes, argv, environment values, or authentication
 // material. An error can follow a committed maintenance write: never retry.
 process.stderr.write('maintenance_failed: no confirmed result; inspect durable evidence before retrying\n');process.exitCode=1;
}finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
