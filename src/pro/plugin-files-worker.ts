import {parentPort,workerData} from 'node:worker_threads';
import {pluginTreeDigestBlocking,fingerprintRequiredPluginsBlocking,readExpectedRemoteVersionBlocking,PluginFingerprintError} from './fingerprint-blocking.ts';
import {ownedProDiagnostic} from './preflight.ts';
if(parentPort===null)throw new Error('Plugin file worker requires an owned parent');
try{
 const {mode,input}=workerData;
 const value=mode==='Tree'?pluginTreeDigestBlocking(input):mode==='Fingerprint'?fingerprintRequiredPluginsBlocking(input):mode==='Manifest'?readExpectedRemoteVersionBlocking(input):(()=>{throw new TypeError('Unknown plugin file operation');})();
 parentPort.postMessage({ok:true,value});
}catch(error){
 const diagnostic=ownedProDiagnostic(error);
 if(diagnostic!==null)parentPort.postMessage({ok:false,kind:'Manifest',diagnostic});
 else if(error instanceof PluginFingerprintError)parentPort.postMessage({ok:false,kind:error.kind,detail:error.detail});
 else parentPort.postMessage({ok:false,kind:'Io',detail:error instanceof Error?error.message:'native plugin file inspection failed'});
}finally{parentPort.close();}
