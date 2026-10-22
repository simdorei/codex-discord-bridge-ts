// Test-only preload inherited by real native worker threads. Any held rollout
// open/read attempt is recorded before it throws, including full-prefix reads.
import fs from 'node:fs';
import promises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {basename} from 'node:path';
import {isMainThread} from 'node:worker_threads';
const append=fs.appendFileSync.bind(fs);
const held=new Set(['bound0','bound1','bound2','bound3','drift','unbound','boundary','archived','orphan'].map(id=>'deferred-'+id));
function check(path,operation){
 const log=process.env.CDR_TEST_DEFERRAL_IO_LOG;
 if(!isMainThread&&log&&typeof path==='string'&&held.has(basename(path).toLowerCase().split('.jsonl')[0])){
  append(log,JSON.stringify({operation})+'\n');throw Error('Forbidden held history IO: '+operation);
 }
}
for(const name of ['open','readFile']){const original=promises[name];promises[name]=function(path,...args){check(path,'promises.'+name);return original.call(this,path,...args);};}
for(const name of ['open','openSync','readFile','readFileSync']){const original=fs[name];fs[name]=function(path,...args){check(path,'fs.'+name);return original.call(this,path,...args);};}
syncBuiltinESMExports();
