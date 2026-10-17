import {join} from 'node:path';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {StoreAuthorityDomain,authorityStorePath} from '../../store/store-authority-domain.ts';
import {PosixRuntimeInstance} from '../runtime-instance.ts';
import {WindowsRuntimeInstance} from '../windows/windows-runtime-instance.ts';
import type {RuntimePaths} from '../runtime-paths/resolve.ts';

/** Explicit opt-in to accounting only. No assertion about external writers,
 * aliases, physical identity, maintenance exclusion or usable dispatch authority. */
export interface LocalStoreAuthorityProfile{readonly kind:'StoreAuthorityAccountingOnly';}
export function captureLocalStoreAuthorityProfile(input:LocalStoreAuthorityProfile):LocalStoreAuthorityProfile{
 if(input===null||typeof input!=='object'||types.isProxy(input)||Object.keys(input).length!==1||Object.getOwnPropertyDescriptor(input,'kind')?.value!=='StoreAuthorityAccountingOnly')throw new TypeError('Expected explicit store accounting profile');
 return Object.freeze({kind:'StoreAuthorityAccountingOnly'});
}
function binding(paths:Pick<RuntimePaths,'root'|'mirrorDb'>):Readonly<{root:string;mirrorDb:string}>{
 const root=authorityStorePath(own(paths,'root') as string),mirrorDb=authorityStorePath(own(paths,'mirrorDb') as string);
 if(mirrorDb!==join(root,'discord_mirror.sqlite'))throw new TypeError('Store accounting requires the original singleton-root bridge path');return Object.freeze({root,mirrorDb});
}
export function requireLocalStoreAuthorityPaths(paths:Pick<RuntimePaths,'root'|'mirrorDb'>):void{binding(paths);}
/** Synchronous enrollment is deliberately before the first storage-preparation
 * await. Authentic singleton ownership is retained until this domain closes. */
export function enrollLocalStoreAuthority(instance:PosixRuntimeInstance|WindowsRuntimeInstance,paths:Pick<RuntimePaths,'root'|'mirrorDb'>,profile:LocalStoreAuthorityProfile):StoreAuthorityDomain{
 captureLocalStoreAuthorityProfile(profile);const pinned=binding(paths);
 const prototype=instance instanceof WindowsRuntimeInstance?WindowsRuntimeInstance.prototype:PosixRuntimeInstance.prototype;
 prototype.requireHeldRoot.call(instance,pinned.root);
 const domain=StoreAuthorityDomain.enroll(pinned.mirrorDb);
 try{prototype.retainStoreAuthority.call(instance,pinned.root,domain);return domain;}catch(error){domain.closeAfterOwnersJoined();throw error;}
}
