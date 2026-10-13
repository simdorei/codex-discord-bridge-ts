import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join,relative} from 'node:path';
import {mkdir,mkdtemp,copyFile,readdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(root,'.runtime'),{recursive:true});
const output=await mkdtemp(join(root,'.runtime/compiled-tests-'));
execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','false','--rewriteRelativeImportExtensions','true','--outDir',output,'--rootDir','.'],{cwd:root,stdio:'inherit'});
const copied=[];
async function copy(path){const destination=join(output,relative(root,path));await mkdir(dirname(destination),{recursive:true});await copyFile(path,destination);copied.push({path:relative(root,path),sha256:createHash('sha256').update(await readFile(destination)).digest('hex')});}
async function visit(path){for(const entry of await readdir(path,{withFileTypes:true})){const item=join(path,entry.name);if(entry.isSymbolicLink())throw new Error('Compiled test fixture symlink requires explicit handling');if(entry.isDirectory())await visit(item);else if(entry.isFile()&&!entry.name.endsWith('.ts'))await copy(item);}}
await visit(join(root,'test'));
// These source files are immutable READ fixtures for the instrumentation test;
// NODE_OPTIONS=--no-strip-types still prevents executing them as TypeScript.
for(const name of ['drain-gate.ts','owned-key.ts'])await copy(join(root,'src/admission',name));
await copy(join(root,'src/core/synchronous-void.ts'));
await copy(join(root,'migration/oracles/sqlite-utf16-0.40.2/decoded-results.json'));
await writeFile(join(output,'fixture-manifest.json'),JSON.stringify({copied},null,2)+'\n');

process.stdout.write(JSON.stringify({output,manifest:join(output,'fixture-manifest.json')})+'\n');
