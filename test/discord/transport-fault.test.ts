import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DiscordTransportFault,ownedDiscordTransportFault} from '../../src/discord/transport-fault.ts';
import {DiscordTransportFault as Legacy} from '../../src/runtime/completion/receipt-sender.ts';
test('central fault brand is shared with legacy runtime import and exposes immutable passive metadata',()=>{
 assert.equal(Legacy,DiscordTransportFault);const e=new DiscordTransportFault('Response','safe',400),record=ownedDiscordTransportFault(e)!;assert.equal(record.status,400);assert.equal(Object.isFrozen(record),true);assert.throws(()=>{(record as {status:number}).status=429;},TypeError);e.message='changed';assert.equal(ownedDiscordTransportFault(e)!.display,'Discord HTTP request failed: safe');let hooks=0;const proxy=new Proxy({},{get(){hooks++;throw new Error('hook');},getPrototypeOf(){hooks++;throw new Error('hook');}});assert.equal(ownedDiscordTransportFault(proxy),undefined);assert.equal(ownedDiscordTransportFault(Object.create(DiscordTransportFault.prototype)),undefined);assert.equal(hooks,0);
});
