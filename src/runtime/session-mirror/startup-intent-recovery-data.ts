import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import type {PendingMirrorStartupIntent} from '../../store/mirror-startup-intent.ts';
import type {MirrorStartupContextResult} from './startup-context-limits.ts';
export interface MirrorStartupDatabaseIdentity {readonly dev:bigint;readonly ino:bigint;readonly birthtimeNs:bigint;}
export interface MirrorStartupRecoveryData {readonly database:MirrorStartupDatabaseIdentity;readonly pending:PendingMirrorStartupIntent;readonly context:MirrorStartupContextResult;}
/** Protocol validation only, never a recovery capability. */
export function snapshotMirrorStartupDatabaseIdentity(input:unknown):MirrorStartupDatabaseIdentity {
 const dev=own(input,'dev'),ino=own(input,'ino'),birthtimeNs=own(input,'birthtimeNs');
 for(const value of [dev,ino,birthtimeNs])if(typeof value!=='bigint'||value<0n||value>=(1n<<64n))throw new TypeError('Invalid startup database identity');
 if(ino===0n||birthtimeNs===0n)throw new TypeError('Missing startup database identity');return Object.freeze({dev,ino,birthtimeNs}) as MirrorStartupDatabaseIdentity;
}
export const sameMirrorStartupDatabase=(a:MirrorStartupDatabaseIdentity,b:MirrorStartupDatabaseIdentity):boolean=>a.dev===b.dev&&a.ino===b.ino&&a.birthtimeNs===b.birthtimeNs;
