import assert from 'node:assert/strict';
import {it} from 'node:test';
import {createHash} from 'node:crypto';
import {RecentMirrorTextCache,normalizedMirrorTextDigest} from '../../../src/runtime/session-mirror/recent-text.ts';

it('retains exact TTL boundary, expires one nanosecond later and isolates scopes',()=>{
 const c=new RecentMirrorTextCache(10n,10);assert.equal(c.remember('thread:turn-a','  update  ',100n),true);
 assert.equal(c.isRecent('thread:turn-a','update',110n),true);assert.equal(c.isRecent('thread:turn-b','update',110n),false);
 assert.equal(c.isRecent('thread:turn-a','update',111n),false);assert.equal(c.size,0);
});
it('backward monotonic readings saturate elapsed at zero',()=>{
 const c=new RecentMirrorTextCache(0n,1);c.remember('a','x',100n);assert.equal(c.isRecent('a','x',99n),true);assert.equal(c.isRecent('a','x',100n),true);assert.equal(c.isRecent('a','x',101n),false);
});
it('uses Rust whitespace and NUL-delimited SHA-256 without BOM trimming',()=>{
 const expected=createHash('sha256').update('hello\0').digest('hex');
 assert.equal(normalizedMirrorTextDigest('\u0085 hello \u0085'),expected);
 assert.notEqual(normalizedMirrorTextDigest('\ufeffhello'),expected);
 assert.notEqual(normalizedMirrorTextDigest('hello\0'),expected);
 const c=new RecentMirrorTextCache(5n,2);c.remember('a','\u0085hello',0n);assert.equal(c.isRecent('a','hello',1n),true);assert.equal(c.isRecent('a','\ufeffhello',1n),false);
});
it('saturation declines caching without evicting or claiming delivery; refresh stays bounded',()=>{
 const c=new RecentMirrorTextCache(10n,2);assert.equal(c.remember('a','x',0n),true);assert.equal(c.remember('b','y',0n),true);
 assert.equal(c.remember('c','z',5n),false);assert.equal(c.size,2);assert.equal(c.isRecent('c','z',5n),false);
 assert.equal(c.remember('a','x',5n),true);assert.equal(c.size,2);assert.equal(c.isRecent('a','x',11n),true);assert.equal(c.size,1);
 assert.equal(c.remember('c','z',11n),true);assert.equal(c.size,2);
});
it('unknown scope lookup and explicit prune remove expired historical scopes',()=>{
 const c=new RecentMirrorTextCache(1n,100);for(let n=0;n<100;n++)c.remember(`old-${n}`,'finished',0n);
 assert.equal(c.size,100);assert.equal(c.isRecent('unknown','different',2n),false);assert.equal(c.size,0);
 c.remember('fresh','new',3n);c.pruneExpired(5n);assert.equal(c.size,0);
});
it('cache limits are UTF-8 byte limits with inclusive boundaries and no oversize storage',()=>{
 const c=new RecentMirrorTextCache(10n,5);const scope='😀'.repeat(1024),text='😀'.repeat(65536);
 assert.equal(c.remember(scope,text,0n),true);assert.equal(c.isRecent(scope,text,1n),true);
 assert.equal(c.remember(scope+'a','x',1n),false);assert.equal(c.remember('a',text+'a',1n),false);
 assert.equal(c.isRecent('a',text+'a',1n),false);assert.equal(c.size,1);
});
it('rejects invalid configuration, clock and non-well-formed strings without coercion',()=>{
 for(const ttl of [-1n,0,NaN,undefined])assert.throws(()=>new RecentMirrorTextCache(ttl as bigint,1),RangeError);
 for(const max of [0,-1,1.5,16385,Infinity,NaN])assert.throws(()=>new RecentMirrorTextCache(1n,max),RangeError);
 const c=new RecentMirrorTextCache(1n,1);for(const now of [-1n,1,NaN])assert.throws(()=>c.pruneExpired(now as bigint),RangeError);
 for(const text of ['\ud800','\udfff',null,{}])assert.throws(()=>c.remember('a',text as string,0n),TypeError);
 assert.throws(()=>c.isRecent('\ud800','x',0n),TypeError);assert.equal(c.size,0);
});
it('new valid remembers prune before capacity checks and blank strings have stable identity',()=>{
 const c=new RecentMirrorTextCache(1n,1);c.remember('','   ',0n);assert.equal(c.isRecent('','',1n),true);
 assert.equal(c.remember('new','text',2n),true);assert.equal(c.size,1);assert.equal(c.isRecent('','',2n),false);
});
