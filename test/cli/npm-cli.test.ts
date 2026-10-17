import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import test from 'node:test';

const launcher = resolve('bin/codex-discord-bridge.mjs');
function run(cwd: string, args: string[]) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(DISCORD_|CODEX_|REMOTE_)/.test(key)) delete env[key];
  return spawnSync(process.execPath, ['--no-strip-types', launcher, ...args], {cwd, env, encoding: 'utf8', windowsHide: true, timeout: 10000});
}
async function fixture(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'cdr-npm-cli-'));
  try { await body(root); } finally { await rm(root, {recursive: true, force: true}); }
}

test('npm version/help run without credentials or runtime startup', async () => fixture(async root => {
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {name: string; version: string};
  const version = run(root, ['--version']); assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), `${manifest.name} ${manifest.version}`);
  const help = run(root, ['--help']); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /--check-config/);
}));

test('npm launcher reads current project .env and compiles worker entry points', async () => fixture(async root => {
  await writeFile(join(root, '.env'), 'DISCORD_BOT_TOKEN=SECRET_FIXTURE_TOKEN\nDISCORD_ALLOWED_CHANNEL_IDS=123\nDISCORD_SESSION_MIRROR=0\n');
  const checked = run(root, ['--check-config']); assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /123/); assert.ok(!JSON.stringify(checked).includes('SECRET_FIXTURE_TOKEN'));
}));

test('explicit env overrides npm default location; missing config reports variable without leaking values', async () => fixture(async root => {
  await writeFile(join(root, 'custom.env'), 'DISCORD_BOT_TOKEN=SECRET_OTHER_TOKEN\nDISCORD_ALLOWED_CHANNEL_IDS=456\n');
  const checked = run(root, ['--env', 'custom.env', '--check-config']); assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /456/); assert.ok(!JSON.stringify(checked).includes('SECRET_OTHER_TOKEN'));
  const missing = run(root, ['--check-config']); assert.equal(missing.status, 1);
  assert.match(missing.stderr, /DISCORD_BOT_TOKEN/);
}));
