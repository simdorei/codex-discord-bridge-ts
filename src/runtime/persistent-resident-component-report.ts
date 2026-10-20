import {types} from 'node:util';

export const PERSISTENT_RESIDENT_COMPONENT_PHASES=Object.freeze(['loading','services','activating','mutation','mutation-handshake','initialized','starting','ready','running','ran','closing','closed','failed'] as const);
export type PersistentResidentComponentPhase=typeof PERSISTENT_RESIDENT_COMPONENT_PHASES[number];

export const PERSISTENT_RESIDENT_FIXTURE_FAILURE_STEPS=Object.freeze(['none','seed','request','respond','child-ack','durable-assert','release-assert'] as const);
export type PersistentResidentFixtureFailureStep=typeof PERSISTENT_RESIDENT_FIXTURE_FAILURE_STEPS[number];

/** Diagnostic from the fixed worker, never main-side process-tree authority. */
export const PERSISTENT_RESIDENT_CHILD_CLOSURES=Object.freeze(['not-started','confirmed','unknown'] as const);
export type PersistentResidentChildClosure=typeof PERSISTENT_RESIDENT_CHILD_CLOSURES[number];

export function capturePersistentResidentComponentReport(value:unknown):Record<string,unknown>{
 if(value===null||typeof value!=='object'||types.isProxy(value)||Array.isArray(value))throw new TypeError('Invalid fixed resident component report');
 const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)throw new TypeError('Invalid fixed resident component report');
 const kindDescriptor=Object.getOwnPropertyDescriptor(value,'kind');
 if(!kindDescriptor||!Object.hasOwn(kindDescriptor,'value')||typeof kindDescriptor.value!=='string')throw new TypeError('Invalid fixed resident component report');
 const keys=kindDescriptor.value==='fixture-result'?['version','kind','scenario','passed']:kindDescriptor.value==='fixture-negative-result'?['version','kind','scenario','assertionsPassed','cleanupQualified','componentQualified']:kindDescriptor.value==='component-failed'?['version','kind','phase','category','fixtureStep','childClosure']:kindDescriptor.value==='component-disposed'?['version','kind','childClosure']:['version','kind'];
 const actual=Reflect.ownKeys(value);if(actual.length!==keys.length||actual.some(k=>typeof k!=='string'||!keys.includes(k)))throw new TypeError('Invalid fixed resident component report');
 const result:Record<string,unknown>=Object.create(null);
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Invalid fixed resident component report');result[key]=d.value;}
 if(result.version!==1)throw new TypeError('Invalid fixed resident component report');
 // receiver-native-stop-observed uses only the default version/kind shape.
 // Its single allowed scenario/phase is enforced by the original main owner;
 // it never carries native exit, loop join, or component release evidence.
 if(result.kind==='fixture-negative-result'&&(result.scenario!=='mutation-cancel-after-write'||result.assertionsPassed!==true||result.cleanupQualified!==false||result.componentQualified!==false))throw new TypeError('Invalid negative fixture qualification report');
 if(result.kind==='component-failed'&&(typeof result.phase!=='string'||!PERSISTENT_RESIDENT_COMPONENT_PHASES.some(phase=>phase===result.phase)||(result.category!=='protocol'&&result.category!=='lifecycle')||typeof result.fixtureStep!=='string'||!PERSISTENT_RESIDENT_FIXTURE_FAILURE_STEPS.some(step=>step===result.fixtureStep)))throw new TypeError('Invalid fixed resident component failure');
 if((result.kind==='component-failed'||result.kind==='component-disposed')&&!PERSISTENT_RESIDENT_CHILD_CLOSURES.some(value=>value===result.childClosure))throw new TypeError('Invalid direct child closure diagnostic');
 return result;
}
/** Internal diagnostic bookkeeping only; never process-exit or release authority. */
export type PersistentResidentReportEvidence=Readonly<{
 reportCorrupt:boolean;
 terminalKind:'none'|'failed'|'disposed';
 directChildClosure:PersistentResidentChildClosure;
}>;
export function createPersistentResidentReportEvidence():PersistentResidentReportEvidence{
 return Object.freeze({reportCorrupt:false,terminalKind:'none',directChildClosure:'unknown'});
}
export function corruptPersistentResidentReportEvidence(prior:PersistentResidentReportEvidence):PersistentResidentReportEvidence{
 return Object.freeze({reportCorrupt:true,terminalKind:prior.terminalKind,directChildClosure:'unknown'});
}
export function acceptPersistentResidentTerminalReport(prior:PersistentResidentReportEvidence,kind:'failed'|'disposed',closure:PersistentResidentChildClosure):PersistentResidentReportEvidence{
 if(prior.reportCorrupt||prior.terminalKind!=='none')return corruptPersistentResidentReportEvidence(prior);
 return Object.freeze({reportCorrupt:false,terminalKind:kind,directChildClosure:closure});
}
