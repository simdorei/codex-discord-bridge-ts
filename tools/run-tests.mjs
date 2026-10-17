import {spawnSync} from 'node:child_process';
import {resolve, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const defaults = [
  'test/cli/npm-cli.test.ts',
  'test/windows-runtime/windows-native.test.ts',
  'test/windows-runtime/windows-singleton-owner.test.ts',
  'test/windows-runtime/windows-atomic-marker.test.ts',
  'test/windows-runtime/windows-runtime.test.ts',
  'test/windows-runtime/windows-process.test.ts',
  'test/windows-runtime/windows-path.test.ts',
  'test/windows-runtime/windows-application.test.ts',
  'test/windows-runtime/windows-resources.test.ts',
];
let inputs = process.argv.slice(2);
if (inputs[0] === '--profile') {
  if (inputs.length !== 2 || !/^[a-z0-9-]+$/.test(inputs[1])) throw new Error('Expected a named test profile');
  inputs = JSON.parse(readFileSync(resolve(root, 'test/profiles', inputs[1] + '.json'), 'utf8'));
  if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every(path => typeof path === 'string'))
    throw new Error('Expected test path array');
}
const selection = (inputs.length === 0 ? defaults : inputs).map(input => {
  const path = relative(root, resolve(root, input));
  if (isAbsolute(path) || path.startsWith('..') || !path.replaceAll('\\', '/').startsWith('test/') || !path.endsWith('.test.ts'))
    throw new Error('Select repository test/*.test.ts files');
  return path;
});
const build = spawnSync(process.execPath, ['tools/build-test-profile.mjs'], {cwd: root, encoding: 'utf8', windowsHide: true});
if (build.status !== 0) {
  process.stderr.write(build.stderr ?? ''); process.stdout.write(build.stdout ?? '');
  throw build.error ?? new Error('Compiled test profile build failed');
}
const {output} = JSON.parse(build.stdout.trim());
const env = {...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-strip-types'].filter(Boolean).join(' ')};
const run = spawnSync(process.execPath, ['--no-strip-types', '--test', '--test-concurrency=1',
  ...selection.map(path => resolve(output, path.replace(/\.ts$/, '.js')))], {cwd: root, env, stdio: 'inherit', windowsHide: true});
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
