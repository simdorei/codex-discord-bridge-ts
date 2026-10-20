import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {runConversation} from './conversation.ts';
import {canonicalProbe,handleEvidence} from './evidence.ts';
export async function runProHelper(args:readonly string[],root:string,env:NodeJS.ProcessEnv=process.env,input:AsyncIterable<Uint8Array>=process.stdin):Promise<string>{
 const command=args[0];if(command==='conversation')return JSON.stringify(runConversation(args.slice(1),env));
 if(command==='verify-cachebuster'||command==='collect-release-evidence'){
  // Release checks deliberately target an explicit built repository. Runtime
  // probes/conversations remain self-contained in a fresh plugin cache.
  const index=args.indexOf('--repo-root'),repo=resolve(index<0?process.cwd():args[index+1]??'');
  const manifest=JSON.parse(await readFile(resolve(repo,'package.json'),'utf8'));if(manifest.name!=='codex-discord-bridge-ts')throw Error('Release checks require the TS repository root');
  const {runReleaseCommand}=await import(pathToFileURL(resolve(repo,'dist/src/pro/release-tools.js')).href);return runReleaseCommand(command,args.slice(1),env);
 }
 if(args.length!==1)throw Error('Unexpected helper argument');root=resolve(env.PLUGIN_ROOT||root);
 if(command==='browser-probe-code')return canonicalProbe(root,'browser');
 if(command==='connector-probe-code'||command==='connector-retry-probe-code')return canonicalProbe(root,'connector',command==='connector-retry-probe-code');
 if(command!=='browser-hook'&&command!=='connector-hook')throw Error('Usage: cdr-pro-helper conversation|browser-probe-code|connector-probe-code|connector-retry-probe-code|browser-hook|connector-hook');
 if(!env.PLUGIN_DATA)throw Error('evidence_hook_failed stage=plugin_data_missing');
 const chunks:Uint8Array[]=[];let size=0;for await(const chunk of input){size+=chunk.byteLength;if(size>8388608)throw Error('Evidence hook input exceeded 8 MiB');chunks.push(chunk);}
 const payload:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));if(payload===null||typeof payload!=='object'||Array.isArray(payload))throw Error('Evidence hook requires an object');
 const output=await handleEvidence(command==='browser-hook'?'browser':'connector',payload as Record<string,unknown>,root,env.PLUGIN_DATA);return output===null?'':JSON.stringify(output);
}
