import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve,relative,sep} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,openSync,closeSync,realpathSync} from 'node:fs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const pinned=join(root,'.runtime/node24/node_modules/node-linux-x64/bin/node');
if(process.version!=='v24.21.0'||realpathSync(process.execPath)!==realpathSync(pinned))throw new Error('Pinned Node24.21.0 required');
if(JSON.parse(readFileSync(join(root,'node_modules/typescript/package.json'),'utf8')).version!=='7.0.2')throw new Error('Pinned TS7.0.2 required');
const mode=process.argv.slice(2);if(mode.length!==1||!['--run','--compile-only'].includes(mode[0]))throw new Error('Explicit --run or --compile-only required');
const production=Object.freeze(['src/runtime/owned-worker-slot.ts','src/runtime/store-worker-authority.ts','src/runtime/store-worker-manifest.ts','src/store/store-authority-domain.ts','src/runtime/runtime-paths/path-text.ts','src/discord/text.ts']);
const roots=Object.freeze(['test/runtime/native-mixed-lane-measurement.test.ts','test/helpers/native-mixed-lane-worker.ts','test/helpers/native-mixed-lane-probe.ts']);
const selected=Object.freeze([...production,...roots].sort());
function safe(path){const normalized=path.replaceAll('\\','/');if(normalized.includes('/remote-agent/')||normalized.includes('/windows/')||normalized.includes('runtime-measurement-driver')||!selected.includes(relative(root,path).replaceAll('\\','/')))throw new Error('Path outside frozen allowlist');}
const hash=value=>createHash('sha256').update(value).digest('hex');
const sources=selected.map(path=>{const full=resolve(root,path);safe(full);return {path,sha256:hash(readFileSync(full))};});
// Only inspect import syntax in this already selected exact allowlist. Manifest
// path strings are inventory, never permission to follow or read another file.
for(const file of sources){const source=readFileSync(join(root,file.path),'utf8');for(const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+\.ts)['"]/g))safe(resolve(dirname(join(root,file.path)),match[1]));}
mkdirSync(join(root,'.runtime'),{recursive:true});const work=mkdtempSync(join(root,'.runtime/native-mixed-lane-measurement-937-')),output=join(work,'emitted');
const compileArgv=Object.freeze(['--no-strip-types',join(root,'node_modules/typescript/bin/tsc'),'--ignoreConfig','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','--strict','--rewriteRelativeImportExtensions','--verbatimModuleSyntax','--noUncheckedIndexedAccess','--exactOptionalPropertyTypes','--types','node','--skipLibCheck','false','--rootDir',root,'--outDir',output,'--listFiles',...selected.map(p=>join(root,p))]);
const runArgv=Object.freeze(['--no-strip-types','--test','--test-concurrency=1','--test-reporter=tap',join(output,'test/runtime/native-mixed-lane-measurement.test.js')]);
const manifest={checkpoint:937,node:'24.21.0',typescript:'7.0.2',sources,toolSha256:hash(readFileSync(fileURLToPath(import.meta.url))),documentationSha256:hash(readFileSync(join(root,'docs/native-mixed-lane-measurement.md'))),compileArgv,runArgv,guardMs:15000,wholeMs:60000,queueExpiryMs:3000,queuedMs:30000,liveMs:15000,ordinaryTimeoutMs:10000,heldMs:30000,probeIntervalMs:25,probeSampleLimit:2400,nativeEventsPerKind:19,probeConstructions:1,refusals:12,submissions:289,offeredBytes:64,totalOfferedFixtureBytes:18496};
writeFileSync(join(work,'frozen-manifest.private.json'),JSON.stringify(manifest,null,2)+'\n');
function execute(argv,name,extra={}){if(!Array.isArray(argv)||argv.length===0||argv.some(x=>typeof x!=='string'||x.length===0))throw new Error('Nonempty exact argv required');const fd=openSync(join(work,name+'.private.log'),'wx');let result;try{result=spawnSync(pinned,argv,{cwd:root,env:{...process.env,NODE_OPTIONS:'--no-strip-types',...extra},stdio:['ignore',fd,fd],timeout:60000});}finally{closeSync(fd);}const receipt={status:result.status,signal:result.signal,error:result.error?.name??null};writeFileSync(join(work,name+'.outcome.json'),JSON.stringify(receipt,null,2)+'\n');if(receipt.status!==0||receipt.signal!==null||receipt.error!==null)throw new Error(name+' failed; preserved attempt '+work);return receipt;}
let receipt={work,manifestSha256:hash(JSON.stringify(manifest))};
try{
 receipt.compile=execute(compileArgv,'compile');
 const actual=readFileSync(join(work,'compile.private.log'),'utf8').split(/\r?\n/).filter(p=>p.startsWith(root+sep)&&!p.includes('/node_modules/')).map(p=>relative(root,p).replaceAll('\\','/')).sort();
 if(JSON.stringify(actual)!==JSON.stringify(selected))throw new Error('Actual compiler file list differs');
 for(const file of sources)if(hash(readFileSync(join(root,file.path)))!==file.sha256)throw new Error('Source byte parity failed');
 const emitted=selected.map(path=>({path:path.replace(/\.ts$/,'.js'),sha256:hash(readFileSync(join(output,path.replace(/\.ts$/,'.js'))))}));writeFileSync(join(work,'emitted-manifest.private.json'),JSON.stringify(emitted,null,2)+'\n');
 if(mode[0]==='--run')receipt.measurement=execute(runArgv,'measurement',{NATIVE_MIXED_LANE_OUTPUT:join(work,'summary.json')});
 for(const file of sources)if(hash(readFileSync(join(root,file.path)))!==file.sha256)throw new Error('Post-run source byte parity failed');
 if(hash(readFileSync(fileURLToPath(import.meta.url)))!==manifest.toolSha256||hash(readFileSync(join(root,'docs/native-mixed-lane-measurement.md')))!==manifest.documentationSha256)throw new Error('Tool/docs byte parity failed');
 receipt.passed=true;
}catch(error){receipt.passed=false;receipt.failure=String(error);process.exitCode=1;}
writeFileSync(join(work,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');process.stdout.write(JSON.stringify(receipt)+'\n');
