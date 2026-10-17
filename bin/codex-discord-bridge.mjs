#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 21) {
  process.stderr.write(`codex-discord-bridge requires Node.js >=24.21.0 <25; current version: ${process.versions.node}\n`);
  process.exitCode = 1;
} else if (process.argv.length === 3 && ['--version', '-v'].includes(process.argv[2])) {
  process.stdout.write(`${manifest.name} ${manifest.version}\n`);
} else {
  const {runLocalRuntimeCli} = await import('../dist/src/cli/local-runtime.js');
  process.exitCode = await runLocalRuntimeCli(join(process.cwd(), 'codex-discord-bridge'), manifest.version);
}
