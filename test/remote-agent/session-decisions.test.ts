import {it} from 'node:test';import assert from 'node:assert/strict';import {decideRemoteSessionActivation,requireRemoteSessionIdentity} from '../../src/remote-agent/session-decisions.ts';import type {RemoteSessionIdentity} from '../../src/remote-agent/session-decisions.ts';
const a:RemoteSessionIdentity=Object.freeze({connectionGeneration:2n,sessionGeneration:5n,sessionId:'session-aaaaaaaa',computerMode:'project'});
const rejection=(message:string)=>({kind:'Reject',message});
it('activation source precedence distinguishes stale connection, stale active session, older generation, conflicting ID and mode',()=>{
 assert.deepEqual(decideRemoteSessionActivation(3n,a,a),rejection('The command belongs to a stale local bridge connection.'));
 assert.deepEqual(decideRemoteSessionActivation(3n,a,{...a,connectionGeneration:3n}),rejection('The project session belongs to a stale bridge connection.'));
 assert.deepEqual(decideRemoteSessionActivation(2n,a,{...a,sessionGeneration:4n}),rejection('The project session command is older than the active session.'));
 assert.deepEqual(decideRemoteSessionActivation(2n,a,{...a,sessionId:'session-bbbbbbbb'}),rejection('The project session generation conflicts with another session.'));
 assert.deepEqual(decideRemoteSessionActivation(2n,a,{...a,computerMode:'device'}),rejection('The project session mode conflicts with the active session.'));
});
it('same identity reuses; newer identity or mode creates without mutating previous state',()=>{
 assert.deepEqual(decideRemoteSessionActivation(2n,a,a),{kind:'Reuse'});assert.deepEqual(decideRemoteSessionActivation(2n,a,{...a,sessionGeneration:6n,sessionId:'session-bbbbbbbb',computerMode:'device'}),{kind:'Create'});assert.deepEqual(decideRemoteSessionActivation(2n,null,a),{kind:'Create'});assert.equal(a.sessionGeneration,5n);assert.equal(Object.isFrozen(decideRemoteSessionActivation(2n,a,a)),true);
});
it('source None connection skips current-generation fence but requires matching active None connection',()=>{
 const unbound={...a,connectionGeneration:null};assert.deepEqual(decideRemoteSessionActivation(9n,null,unbound),{kind:'Create'});assert.deepEqual(decideRemoteSessionActivation(9n,unbound,unbound),{kind:'Reuse'});assert.deepEqual(decideRemoteSessionActivation(9n,a,unbound),rejection('The project session belongs to a stale bridge connection.'));
 assert.deepEqual(requireRemoteSessionIdentity(9n,unbound,a.sessionId,null),{kind:'Current'});assert.deepEqual(requireRemoteSessionIdentity(9n,a,a.sessionId,null),rejection('The ChatGPT session is stale or was not acknowledged locally.'));
});
it('require-session fails closed for missing session, null or wrong ID, stale current or active connection',()=>{
 const message='The ChatGPT session is stale or was not acknowledged locally.';assert.deepEqual(requireRemoteSessionIdentity(2n,a,a.sessionId,2n),{kind:'Current'});
 for(const [active,id] of [[null,a.sessionId],[a,null],[a,'session-bbbbbbbb'],[{...a,connectionGeneration:1n},a.sessionId]] as const)assert.deepEqual(requireRemoteSessionIdentity(2n,active,id,2n),rejection(message));
 assert.deepEqual(requireRemoteSessionIdentity(3n,a,a.sessionId,2n),rejection('The command belongs to a stale local bridge connection.'));
});
it('stale connection short-circuits active identity inspection and active accessors never execute',()=>{
 let hooks=0;const poisoned={get connectionGeneration(){hooks++;return 2n;}} as RemoteSessionIdentity;
 assert.deepEqual(decideRemoteSessionActivation(3n,poisoned,a),rejection('The command belongs to a stale local bridge connection.'));assert.equal(hooks,0);assert.throws(()=>decideRemoteSessionActivation(2n,poisoned,a),TypeError);assert.equal(hooks,0);
 assert.throws(()=>decideRemoteSessionActivation(2n,null,{...a,sessionGeneration:18446744073709551616n}),TypeError);
 assert.deepEqual(decideRemoteSessionActivation(2n,a,{...a,sessionGeneration:18446744073709551615n}),{kind:'Create'});
});
