export type LegacyMirrorPolicy='strict'|'rust-preserve';
export function legacyMirrorPolicy(value:unknown):LegacyMirrorPolicy{
 if(value===undefined||value==='strict')return 'strict';
 if(value==='rust-preserve')return value;
 throw new Error('Invalid legacy mirror policy; expected strict or rust-preserve');
}
