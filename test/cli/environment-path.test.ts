import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,symlinkSync,writeFileSync} from 'node:fs';import {dirname,join} from 'node:path';
import {storeFixture} from '../helpers/store-fixture.ts';
import {loadStartupEnvironmentOffThread,defaultStartupEnvironmentPath} from '../../src/cli/environment.ts';
test('explicit environment path preserves native symlink-parent traversal',()=>storeFixture(async p=>{
 const root=dirname(p),physical=join(root,'physical'),child=join(physical,'child');mkdirSync(child,{recursive:true});symlinkSync(child,join(root,'alias'),'dir');writeFileSync(join(root,'.env'),'MARKER=wrong\n');writeFileSync(join(physical,'.env'),'MARKER=correct\n');
 const result=await loadStartupEnvironmentOffThread(new Map(),root+'/alias/../.env','/ignored/app');assert.equal(result.get('MARKER'),'correct');
}));
test('default environment beside application preserves native symlink-parent traversal',()=>storeFixture(async p=>{
 const root=dirname(p),physical=join(root,'physical'),child=join(physical,'child');mkdirSync(child,{recursive:true});symlinkSync(child,join(root,'alias'),'dir');writeFileSync(join(root,'.env'),'MARKER=wrong\n');writeFileSync(join(physical,'.env'),'MARKER=correct\n');
 const app=root+'/alias/../app';assert.equal(defaultStartupEnvironmentPath(app),root+'/alias/../.env');const result=await loadStartupEnvironmentOffThread(new Map(),null,app);assert.equal(result.get('MARKER'),'correct');
}));
