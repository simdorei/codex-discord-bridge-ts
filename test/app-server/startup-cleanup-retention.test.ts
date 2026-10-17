import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PortableSessionCleanupPendingError,requiresPortableSessionCleanupRetention as retain} from '../../src/app-server/portable-session.ts';

// Error-routing checks only. Deliberately supply no session/resource object:
// these sentinels cannot prove a live owner, failed native cleanup or root hold.
const pending=(cause:unknown)=>new PortableSessionCleanupPendingError(undefined as never,cause);

test('constructor-created pending error is retained without reading owner or cause',()=>{
  const cause=Object.freeze({original:true}),error=pending(cause);let calls=0;
  assert.equal(error.session,undefined);assert.equal(error.cause,cause);
  for(const key of ['session','cause'])Object.defineProperty(error,key,{get(){calls++;throw Error('must not inspect');}});
  assert.equal(retain(error),true);assert.equal(calls,0);
});

test('direct and nested native aggregates preserve all original identities',()=>{
  const original=pending('startup'),secondary=Object.freeze({cleanup:true});
  const inner=new AggregateError([original,secondary],'resident'),outer=new AggregateError([new Error('other'),inner],'outer');
  const innerErrors=inner.errors,outerErrors=outer.errors;
  assert.equal(retain(inner),true);assert.equal(retain(outer),true);
  assert.equal(inner.errors,innerErrors);assert.equal(outer.errors,outerErrors);
  assert.equal(inner.errors[0],original);assert.equal(inner.errors[1],secondary);assert.equal(outer.errors[1],inner);
});

test('native aggregate subclasses and cyclic repeated wrappers are inspected finitely',()=>{
  class CleanupGroup extends AggregateError{}
  const original=pending(null),group=new CleanupGroup([],'group');group.errors.push(group,group,original);
  assert.equal(retain(group),true);assert.equal(group.errors[2],original);
  const empty=new AggregateError([]);empty.errors.push(empty,empty);assert.equal(retain(empty),false);
});

test('ordinary errors and arbitrary cause or shaped records do not become pending owners',()=>{
  const original=pending(null),ordinary=new Error('ordinary',{cause:original});
  for(const value of [undefined,null,false,1,'pending',{},ordinary,new AggregateError([ordinary,null]),
    {name:'PortableSessionCleanupPendingError',session:original},Object.create(PortableSessionCleanupPendingError.prototype),
    Object.create(AggregateError.prototype)])assert.equal(retain(value),false);
});

test('proxies and arbitrary getters are not executed',()=>{
  let calls=0;const trap=()=>{calls++;throw Error('proxy inspected');};
  const proxy=new Proxy({}, {get:trap,getPrototypeOf:trap,getOwnPropertyDescriptor:trap,ownKeys:trap});
  assert.equal(retain(proxy),false);assert.equal(retain(new AggregateError([proxy])),false);
  const ordinary=Object.defineProperty({},'errors',{get:trap});assert.equal(retain(ordinary),false);
  const error=new Error('opaque prototype');Object.setPrototypeOf(error,proxy);
  assert.equal(retain(error),true);assert.equal(calls,0);
});

test('opaque native aggregate lists conservatively retain without running hooks',()=>{
  let calls=0;const trap=()=>{calls++;throw Error('active error list');};
  const getter=new AggregateError([]);Object.defineProperty(getter,'errors',{get:trap});assert.equal(retain(getter),true);
  const item=new AggregateError([]);Object.defineProperty(item.errors,'0',{get:trap});assert.equal(retain(item),true);
  const proxy=new AggregateError([]);proxy.errors=new Proxy([], {get:trap,getOwnPropertyDescriptor:trap});assert.equal(retain(proxy),true);
  const revoked=Proxy.revocable([],{});revoked.revoke();const opaque=new AggregateError([]);opaque.errors=revoked.proxy;assert.equal(retain(opaque),true);assert.equal(retain(revoked.proxy),false);
  const malformed=new AggregateError([]);Object.defineProperty(malformed,'errors',{value:null});assert.equal(retain(malformed),true);
  assert.equal(calls,0);
});

test('array iteration hooks are ignored and sparse native lists stay passive',()=>{
  let calls=0;const original=pending(null),group=new AggregateError([]),list:unknown[]=[];
  list.length=3;list[2]=original;Object.defineProperty(list,Symbol.iterator,{get(){calls++;throw Error('iterator');}});group.errors=list;
  assert.equal(retain(group),true);assert.equal(calls,0);assert.equal(group.errors,list);
});

test('inspection budget exhaustion retains uncertainty rather than authorizing release',()=>{
  const wide=new AggregateError([]);wide.errors.length=1025;assert.equal(retain(wide),true);
  let nested:unknown=null;for(let i=0;i<600;i++)nested=new AggregateError([nested]);assert.equal(retain(nested),true);
});
