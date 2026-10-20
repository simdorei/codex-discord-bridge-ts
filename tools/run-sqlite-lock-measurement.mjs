import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve,relative,sep} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,openSync,closeSync,realpathSync} from 'node:fs';
// Only additive checkpoint929 roots. This runner never invokes Git, a broad
// build/test, a provider, or a live DB. First compile, review, then explicit run.
if(process.version!=='v24.21.0')throw Error('Pinned Node 24.21.0 required');
const root=realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const deny=p=>/\/test\/remote-agent\/redaction\.test\.ts$|\/remote-agent\/[^\n]*native-read|\/src\/runtime\/windows\/|\/native\/windows-runtime\/|\/test\/windows-runtime\/|\/tools\/windows-runtime\/|\/docs\/windows-runtime\//.test(p.replaceAll('\\','/'));
function guarded(p){const absolute=resolve(p);if(!absolute.startsWith(root+sep)||deny(absolute))throw Error('Forbidden selected dependency before read');const actual=realpathSync(absolute);if(!actual.startsWith(root+sep)||deny(actual))throw Error('Forbidden resolved dependency before read');return actual;}
const read=p=>readFileSync(guarded(p),'utf8');
if(JSON.parse(read(join(root,'node_modules/typescript/package.json'))).version!=='7.0.2')throw Error('Pinned TypeScript 7.0.2 required');
const args=process.argv.slice(2),compileOnly=args.length===1&&args[0]==='--compile-only',reviewed=args.length===2&&args[0]==='--run-reviewed'?resolve(args[1]):null;
if(!compileOnly&&!reviewed)throw Error('Use --compile-only, review the frozen graph, then --run-reviewed PRIVATE_DIRECTORY');
const roots=['test/helpers/sqlite-lock-probe-worker.ts','test/helpers/sqlite-lock-holder-worker.ts','src/runtime/message-worker/native-journal-worker.ts','test/runtime/discord-runtime/installed-sqlite-lock-measurement.test.ts'];
const sources=new Map();
function visit(p){const filename=guarded(p);if(sources.has(filename))return;const source=read(filename);sources.set(filename,source);for(const match of source.matchAll(/(?:from\s*|import\s*\(?\s*|new URL\(\s*)['"](\.[^'"]+\.ts)['"]/g))visit(resolve(dirname(filename),match[1]));}
roots.forEach(p=>visit(join(root,p)));
const selected=[...sources.keys()].sort(),sha=x=>createHash('sha256').update(x).digest('hex');
const sourceFiles=selected.map(p=>({path:relative(root,p),sha256:sha(sources.get(p))})),sourceGraphSha256=sha(JSON.stringify(sourceFiles)),runnerSha256=sha(read(fileURLToPath(import.meta.url)));
mkdirSync(join(root,'.runtime'),{recursive:true});
const work=reviewed??mkdtempSync(join(root,'.runtime/sqlite-lock-measurement-929-'));
if(!work.startsWith(join(root,'.runtime/sqlite-lock-measurement-929-')))throw Error('Expected private selected profile');
const output=join(work,'emitted');
function execute(command,logName,env=process.env,timeout=120000){const fd=openSync(join(work,logName),'wx');let result;try{result=spawnSync(process.execPath,['--no-strip-types',...command],{cwd:root,stdio:['ignore',fd,fd],env,timeout});}finally{closeSync(fd);}return {status:result.status,signal:result.signal,error:result.error?.name??null};}
if(reviewed){
 const manifest=JSON.parse(read(join(work,'compile-manifest.private.json'))),profile=manifest.profile;
 if(profile.sourceGraphSha256!==sourceGraphSha256||profile.runnerSha256!==runnerSha256)throw Error('Frozen sources/runner changed after review');
 const emitted=manifest.emittedFiles.map(f=>({path:f.path,sha256:sha(read(join(output,f.path)))}));if(JSON.stringify(emitted)!==JSON.stringify(manifest.emittedFiles))throw Error('Frozen emitted graph changed after review');
 if(manifest.roots.join('\n')!==roots.join('\n'))throw Error('Frozen root list changed');
 const measurement=execute(['--test','--test-concurrency=1','--test-reporter=tap',join(output,'test/runtime/discord-runtime/installed-sqlite-lock-measurement.test.js')],'measurement.private.tap',{...process.env,NODE_OPTIONS:'--no-strip-types',SQLITE_LOCK_MEASUREMENT_OUTPUT:join(work,'measurement.private.json')},120000);
 const receipt={work,profile,measurement};writeFileSync(join(work,'run-receipt.json'),JSON.stringify(receipt,null,2)+'\n');process.stdout.write(JSON.stringify(receipt)+'\n');if(measurement.status!==0)process.exitCode=1;
}else{
 const compilerOptions={target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:false,rewriteRelativeImportExtensions:true,verbatimModuleSyntax:true,noUncheckedIndexedAccess:true,exactOptionalPropertyTypes:true,types:['node'],skipLibCheck:false,rootDir:root,outDir:output};
 const config=join(work,'tsconfig.private.json');writeFileSync(config,JSON.stringify({compilerOptions,files:selected,include:[],exclude:[]},null,2)+'\n');
 const compile=execute([join(root,'node_modules/typescript/bin/tsc'),'-p',config,'--listFiles'],'compile.private.log');
 if(compile.status!==0){process.stdout.write(JSON.stringify({work,compile})+'\n');process.exitCode=1;}else{
  const listed=read(join(work,'compile.private.log')).split(/\r?\n/).filter(p=>p.startsWith(root+sep)&&!p.includes('/node_modules/')).sort();if(JSON.stringify(listed)!==JSON.stringify(selected))throw Error('Actual compiler project graph differs');
  const emittedFiles=sourceFiles.map(f=>({path:f.path.replace(/\.ts$/,'.js'),sha256:sha(read(join(output,f.path.replace(/\.ts$/,'.js'))))}));
  const profile={checkpoint:929,baseLocal:'688151fec24bcd87d7efa3ff5941431c16271200',baseRemote:'807a421723fca4473498dc19f6b6830477cfca2b',baseTree:'6896e236e165c9e5c7ad8c7fc1c778f5a2641ab6',node:'24.21.0',typescript:'7.0.2',sourceGraphSha256,sourceFiles:sourceFiles.length,emittedGraphSha256:sha(JSON.stringify(emittedFiles)),emittedModules:emittedFiles.length,runnerSha256,compilerActualGraphAudited:true,protectedExcluded:true,nativeRead913Excluded:true,reservedWindowsExcluded:true};profile.profileSha256=sha(JSON.stringify({profile,roots,sourceFiles}));
  writeFileSync(join(output,'measurement-profile.json'),JSON.stringify(profile,null,2)+'\n');writeFileSync(join(work,'compile-manifest.private.json'),JSON.stringify({profile,roots,sourceFiles,emittedFiles,compilerOptions},null,2)+'\n');writeFileSync(join(work,'compile-receipt.json'),JSON.stringify({work,profile,compile},null,2)+'\n');process.stdout.write(JSON.stringify({work,profile,compile})+'\n');
 }
}
