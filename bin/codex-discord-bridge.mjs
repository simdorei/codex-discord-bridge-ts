#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 21) {
  process.stderr.write(`codex-discord-bridge requires Node.js >=24.21.0 <25; current version: ${process.versions.node}\n`);
  process.exitCode = 1;
} else if (process.argv.length === 3 && ['--version', '-v'].includes(process.argv[2])) {
  process.stdout.write(`${manifest.name} ${manifest.version}\n`);
} else {
  try {
    const {runCutoverCli} = await import('../dist/src/cli/cutover.js');
    const cutover = await runCutoverCli(process.argv.slice(2), fileURLToPath(import.meta.url));
    if (cutover !== null) { process.exitCode = cutover; }
    else {
    const {runWindowsControlCli} = await import('../dist/src/cli/windows-control.js');
    const control = await runWindowsControlCli(process.argv.slice(2), fileURLToPath(import.meta.url));
    if (control !== null) process.exitCode = control;
    else {
      const {runLocalRuntimeCli} = await import('../dist/src/cli/local-runtime.js');
      process.exitCode = await runLocalRuntimeCli(join(process.cwd(), 'codex-discord-bridge'), manifest.version);
    }
    }
  } catch (error) {
    process.stderr.write(`runtime_control_failed: ${error instanceof Error ? error.message : 'inspect local evidence'}\n`);
    process.exitCode = 1;
  }
}
