import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve, relative, sep} from 'node:path';
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, openSync, closeSync} from 'node:fs';

// A bounded synthetic experiment, not a production launcher or full test build.
// Its compiler config and raw logs remain private under the ignored .runtime.
if (process.version !== 'v24.21.0') throw new Error('Use pinned Node 24.21.0');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const compilerVersion = JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8')).version;
if (compilerVersion !== '7.0.2') throw new Error('Use pinned TypeScript 7.0.2');
const compileOnly = process.argv.slice(2).join(' ') === '--compile-only';
if (process.argv.length > 2 && !compileOnly) throw new Error('Only --compile-only is supported');
const denied = filename => /\/test\/remote-agent\/redaction\.test\.ts$|\/remote-agent\/[^\n]*native-read|\/src\/runtime\/windows\/|\/native\/windows-runtime\/|\/test\/windows-runtime\/|\/tools\/windows-runtime\/|\/docs\/windows-runtime\//.test(filename.replaceAll('\\', '/'));
const rootFiles = [
  'test/helpers/runtime-measurement-driver.ts',
  'test/runtime/discord-runtime/runtime-measurement-accounting.test.ts',
  'test/runtime/discord-runtime/synthetic-runtime-measurement.test.ts',
];
const sources = new Map();
function visit(filename) {
  filename = resolve(filename);
  if (!filename.startsWith(root + sep) || denied(filename)) throw new Error('Selected graph reached a forbidden path');
  if (sources.has(filename)) return;
  const source = readFileSync(filename, 'utf8');
  sources.set(filename, source);
  // Walk only static relative dependencies and literal native-worker URLs in
  // already selected files. Never enumerate or recursively build the test tree.
  for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*|new URL\(\s*)['"](\.[^'"]+\.ts)['"]/g)) {
    visit(resolve(dirname(filename), match[1]));
  }
}
for (const filename of rootFiles) visit(join(root, filename));
mkdirSync(join(root, '.runtime'), {recursive: true});
const work = mkdtempSync(join(root, '.runtime/runtime-measurement-917-'));
const output = join(work, 'emitted');
const compilerOptions = {target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: false,
  rewriteRelativeImportExtensions: true, verbatimModuleSyntax: true, noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true, types: ['node'], skipLibCheck: false, rootDir: root, outDir: output};
const selected = [...sources.keys()].sort();
const configPath = join(work, 'tsconfig.private.json');
writeFileSync(configPath, JSON.stringify({compilerOptions, files: selected, include: [], exclude: []}, null, 2) + '\n');
function execute(args, logName, env = process.env) {
  const descriptor = openSync(join(work, logName), 'w');
  let result;
  try {result = spawnSync(process.execPath, ['--no-strip-types', ...args], {cwd: root, stdio: ['ignore', descriptor, descriptor], env});}
  finally {closeSync(descriptor);}
  const outcome = {status: result.status, signal: result.signal, error: result.error?.name ?? null};
  writeFileSync(join(work, `${logName}.outcome.json`), JSON.stringify(outcome, null, 2) + '\n');
  return outcome;
}
const compile = execute([join(root, 'node_modules/typescript/bin/tsc'), '-p', configPath, '--listFiles'], 'compile.private.log');
if (compile.status !== 0) {process.stdout.write(JSON.stringify({work, compile}) + '\n'); process.exitCode = 1;}
else {
  // Verify the compiler's actual project-source graph, not just declared roots.
  const listed = readFileSync(join(work, 'compile.private.log'), 'utf8').split(/\r?\n/).filter(line => line.startsWith(root + sep) && !line.includes('/node_modules/')).sort();
  if (JSON.stringify(listed) !== JSON.stringify(selected)) throw new Error('Actual compiler graph differs from selected graph');
  const sourceFiles = selected.map(filename => ({path: relative(root, filename), sha256: createHash('sha256').update(sources.get(filename)).digest('hex')}));
  const sourceGraphSha256 = createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex');
  const emittedFiles = sourceFiles.map(file => ({path: file.path.replace(/\.ts$/, '.js'), sha256: createHash('sha256').update(readFileSync(join(output, file.path.replace(/\.ts$/, '.js')))).digest('hex')}));
  const emittedGraphSha256 = createHash('sha256').update(JSON.stringify(emittedFiles)).digest('hex');
  const toolSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  const profile = {baseHead: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), sourceGraphSha256,
    sourceFiles: sourceFiles.length, emittedGraphSha256, emittedModules: emittedFiles.length, toolSha256,
    emission: 'TypeScript 7.0.2, ES2023/NodeNext, strict, rewritten .js imports, private explicit roots and reachable literal worker URLs',
    node: '24.21.0', protectedTestExcluded: true, nativeRead913Excluded: true, reservedWindowsExcluded: true};
  profile.profileSha256 = createHash('sha256').update(JSON.stringify({profile, rootFiles, sourceFiles})).digest('hex');
  writeFileSync(join(output, 'measurement-profile.json'), JSON.stringify(profile, null, 2) + '\n');
  writeFileSync(join(work, 'compile-manifest.private.json'), JSON.stringify({profile, rootFiles, sourceFiles, emittedFiles, compilerOptions}, null, 2) + '\n');
  const receipt = {work, profile, compile};
  if (!compileOnly) {
    receipt.accounting = execute(['--test', '--test-concurrency=1', '--test-reporter=tap', join(output, 'test/runtime/discord-runtime/runtime-measurement-accounting.test.js')], 'accounting.private.tap');
    if (receipt.accounting.status === 0) {
      receipt.measurement = execute(['--test', '--test-concurrency=1', '--test-reporter=tap', join(output, 'test/runtime/discord-runtime/synthetic-runtime-measurement.test.js')],
        'measurement.private.tap', {...process.env, NODE_OPTIONS: '--no-strip-types', RUNTIME_MEASUREMENT_OUTPUT: join(work, 'measurement.json')});
    }
    if (receipt.accounting.status !== 0 || receipt.measurement?.status !== 0) process.exitCode = 1;
  }
  writeFileSync(join(work, 'run-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  process.stdout.write(JSON.stringify(receipt) + '\n');
}
