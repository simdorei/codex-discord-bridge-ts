import {prepareMaintenanceStartup} from './maintenance.ts';
import {runAdmin} from './admin.ts';
import {RuntimeConfigError} from '../config/runtime.ts';
import {RuntimeExecutableError} from '../runtime/runtime-paths/executable.ts';
import {RuntimePathDiscoveryError} from '../runtime/runtime-paths/discovery.ts';
import {RuntimeStopSignal} from '../runtime/discord-runtime/stop-signal.ts';
import {runLocalRuntimeApplication, LocalRuntimeUnsupportedError, LocalRuntimeOwnershipRetainedError} from '../runtime/discord-runtime/local-application.ts';

/** npm supplies the project-local environment location and package version.
 * Direct legacy entry points retain their original environment location. */
export async function runLocalRuntimeCli(applicationPath: string, version: string): Promise<number> {
  try {
    if (process.versions.node.split('.')[0] !== '24') throw new Error('Node24 required');
    const env = new Map<string, string>();
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env.set(key, value);
    const stop = RuntimeStopSignal.install(); let prepared;
    try { prepared = await prepareMaintenanceStartup(process.argv.slice(2), env, applicationPath, process.cwd(), version, stop.signal);
      if(prepared.kind==='admin')prepared={kind:'output' as const,text:await runAdmin(prepared.args,env,process.cwd(),version,stop.signal)};
    }
    finally { stop.dispose(); }
    if (prepared.kind === 'output') process.stdout.write(prepared.text + '\n');
    else {
      const environment: Record<string, string> = Object.create(null);
      Map.prototype.forEach.call(prepared.environment, (value: string, key: string) => { Object.defineProperty(environment, key, {value, enumerable: true}); });
      await runLocalRuntimeApplication(prepared.config, environment, process.cwd(), version);
    }
    return 0;
  } catch (error) {
    if (error instanceof LocalRuntimeUnsupportedError) {
      process.stderr.write('local_runtime_unsupported_profile: host commands require Windows\n'); return 2;
    }
    if (error instanceof LocalRuntimeOwnershipRetainedError) process.stderr.write('local_runtime_ownership_retained: cleanup unconfirmed; do not restart\n');
    else if (error instanceof RuntimeConfigError) process.stderr.write(`local_runtime_config: ${error.message}\n`);
    else if (error instanceof RuntimeExecutableError || error instanceof RuntimePathDiscoveryError)
      process.stderr.write(`local_runtime_path: ${error.message}\n`);
    else process.stderr.write('local_runtime_failed: no confirmed result; inspect durable evidence before retrying\n');
    return 1;
  }
}
