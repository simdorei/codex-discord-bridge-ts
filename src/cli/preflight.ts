import {planStartup,helpText,configSummary} from './startup.ts';import type {StartupArgs} from './startup.ts';
import {loadStartupEnvironmentOffThread} from './environment.ts';
import {loadRuntimeConfig} from '../config/runtime.ts';import type {RuntimeConfig} from '../config/runtime.ts';
export type PreparedStartup=
 | Readonly<{kind:'admin';args:readonly string[]}>
 | Readonly<{kind:'output';text:string}>
 | Readonly<{kind:'restartReadiness';args:StartupArgs;environment:Map<string,string>}>
 | Readonly<{kind:'backupStore'|'gateway';args:StartupArgs;environment:Map<string,string>;config:RuntimeConfig}>;
/** Source main's front-end branch ordering with actual native environment read.
 * Admin/help return before file access; readiness returns before config/token
 * validation; check-config returns before backup/gateway effects. Returned admin,
 * readiness, backup and gateway work still requires its actual owned executor.
 * This is not a standalone main, singleton acquisition or permission to connect.
 * RuntimeConfig's bounded startup parsing remains synchronous after native read. */
export async function prepareStartup(argv:readonly string[],environment:ReadonlyMap<string,string>,applicationPath:string,signal?:AbortSignal):Promise<PreparedStartup>{
 const plan=planStartup(argv);
 if(plan.kind==='admin')return Object.freeze({kind:'admin',args:Object.freeze([...(plan.adminArgs??[])])});
 if(plan.kind==='help')return Object.freeze({kind:'output',text:helpText()});
 const args=plan.args;if(args===null)throw new TypeError('Startup plan has no parsed arguments');Object.freeze(args.cli);Object.freeze(args);
 const captured=await loadStartupEnvironmentOffThread(environment,args.envPath,applicationPath,signal);signal?.throwIfAborted();
 if(plan.kind==='restartReadiness')return Object.freeze({kind:'restartReadiness',args,environment:captured});
 const config=loadRuntimeConfig(captured,args.cli);
 if(plan.kind==='checkConfig')return Object.freeze({kind:'output',text:configSummary(config)});
 if(plan.kind==='backupStore'||plan.kind==='gateway')return Object.freeze({kind:plan.kind,args,environment:captured,config});
 throw new TypeError('Unknown startup plan branch');
}
