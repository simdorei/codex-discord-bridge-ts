import {it} from 'node:test';import assert from 'node:assert/strict';
import {RemoteAgentStatus,RemoteAgentControl,nextRemoteGeneration} from '../../src/remote-agent/agent-state.ts';
it('status defaults disconnected at generation zero and only explicit acknowledged transition sets connected',()=>{
 const status=new RemoteAgentStatus();assert.deepEqual(status.snapshot(),{connected:false,generation:0n});status.setConnected(7n);assert.equal(status.isConnected(),true);assert.equal(status.generation(),7n);status.setDisconnected();assert.deepEqual(status.snapshot(),{connected:false,generation:7n});
});
it('status clones share subsequent state but snapshots and independently created owners stay isolated',()=>{
 const status=new RemoteAgentStatus(),clone=status.clone(),independent=new RemoteAgentStatus(),before=status.snapshot();clone.setConnected(2n);assert.equal(status.generation(),2n);assert.equal(independent.generation(),0n);assert.equal(before.generation,0n);assert.equal(Object.isFrozen(before),true);status.setDisconnected();assert.equal(clone.isConnected(),false);
});
it('diagnostic status does not replace dispatcher generation authority or invent monotonic validation',()=>{
 const status=new RemoteAgentStatus();status.setConnected(10n);status.setConnected(1n);assert.equal(status.generation(),1n);status.setConnected(0n);assert.equal(status.generation(),0n);
});
it('generation increment saturates at u64 maximum without narrowing or resetting',()=>{
 assert.equal(nextRemoteGeneration(0n),1n);assert.equal(nextRemoteGeneration(18446744073709551614n),18446744073709551615n);assert.equal(nextRemoteGeneration(18446744073709551615n),18446744073709551615n);
 for(const v of [-1n,18446744073709551616n,1 as unknown as bigint]){assert.throws(()=>nextRemoteGeneration(v),RangeError);assert.throws(()=>new RemoteAgentStatus().setConnected(v),RangeError);}
});
it('restart handoff is explicit sticky shared state without affecting status or other controls',()=>{
 const control=new RemoteAgentControl(),clone=control.clone(),other=new RemoteAgentControl();assert.equal(control.restartHandoffRequested(),false);clone.requestRestartHandoff();clone.requestRestartHandoff();assert.equal(control.restartHandoffRequested(),true);assert.equal(other.restartHandoffRequested(),false);
});
it('frozen owned instances and private brands reject forged receiver state',()=>{
 const status=new RemoteAgentStatus(),control=new RemoteAgentControl();assert.equal(Object.isFrozen(status),true);assert.equal(Object.isFrozen(control),true);assert.throws(()=>RemoteAgentStatus.prototype.setConnected.call(Object.create(RemoteAgentStatus.prototype),1n),TypeError);assert.throws(()=>RemoteAgentControl.prototype.requestRestartHandoff.call(Object.create(RemoteAgentControl.prototype)),TypeError);
});
