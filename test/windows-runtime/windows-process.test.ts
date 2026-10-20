import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import test from 'node:test';
import {OwnedPortableAppServerProcess} from '../../src/app-server/portable-process.ts';
import {FatalUtf8LineReader} from '../../src/app-server/line-reader.ts';

const windows = {skip: process.platform !== 'win32', timeout: 15000};
const treeCode = `import {spawn} from 'node:child_process';
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true});
  child.once('spawn',()=>process.stdout.write(JSON.stringify({pid:process.pid,descendant:child.pid})+'\\n'));
  setInterval(()=>{},1000);`;
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function requireExited(pids: number[]): Promise<void> {
  const deadline = performance.now() + 5000;
  while (pids.some(alive) && performance.now() < deadline) await sleep(10);
  for (const pid of pids) assert.equal(alive(pid), false, `owned fixture process ${pid} remains alive`);
}

test('Windows reports provider identity and force disposal joins its entire native job', windows, async t => {
  const child = await OwnedPortableAppServerProcess.spawn({executable: process.execPath,
    arguments: ['--input-type=module', '-e', treeCode], environment: {}});
  t.after(() => child.forceDispose());
  const line = await new FatalUtf8LineReader(child.stdout).nextLine(); assert.ok(line);
  const ids = JSON.parse(line) as {pid: number; descendant: number};
  assert.equal(child.processId, ids.pid); assert.ok(alive(ids.descendant));
  await child.forceDispose(); assert.equal(child.exitConfirmed, true); assert.equal(child.stdioClosed, true);
  await requireExited([ids.pid, ids.descendant]);
});

test('Windows parent crash closes the job and kills only its fixture provider tree', windows, async () => {
  const module = new URL('../../src/app-server/portable-process.js', import.meta.url).href;
  const lines = new URL('../../src/app-server/line-reader.js', import.meta.url).href;
  const code = `import {OwnedPortableAppServerProcess} from ${JSON.stringify(module)};
    import {FatalUtf8LineReader} from ${JSON.stringify(lines)};
    const child=await OwnedPortableAppServerProcess.spawn({executable:process.execPath,arguments:['--input-type=module','-e',${JSON.stringify(treeCode)}],environment:{}});
    process.stdout.write(await new FatalUtf8LineReader(child.stdout).nextLine()+'\\n');setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ['--no-strip-types', '--input-type=module', '-e', code], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  const closed = new Promise<void>((resolve, reject) => { parent.once('error', reject); parent.once('close', () => resolve()); });
  let output = '';
  try {
    const ids = await new Promise<{pid: number; descendant: number}>((resolve, reject) => {
      parent.stdout.on('data', chunk => { output += String(chunk); if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]!)); });
      parent.once('error', reject); parent.once('exit', () => reject(new Error('Fixture parent exited before readiness')));
    });
    assert.equal(parent.kill('SIGKILL'), true); await closed;
    await requireExited([ids.pid, ids.descendant]);
  } finally { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); await closed; }
});

test('Windows independent app-server strips inherited desktop session identity and honors explicit overrides', windows, async t => {
  const previous = {CODEX_SESSION_ID: process.env.CODEX_SESSION_ID, CODEX_APP_TOOLS_PIPE_PATH: process.env.CODEX_APP_TOOLS_PIPE_PATH};
  t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  process.env.CODEX_SESSION_ID = 'parent-only';
  process.env.CODEX_APP_TOOLS_PIPE_PATH = 'parent-private-pipe';
  const child = await OwnedPortableAppServerProcess.spawn({executable: process.execPath,
    arguments: ['-e', 'process.stdout.write(JSON.stringify({session:process.env.CODEX_SESSION_ID??null,pipe:process.env.CODEX_APP_TOOLS_PIPE_PATH??null,home:process.env.CODEX_HOME})+"\\n")'],
    environment: {CODEX_HOME: 'fixture-home', CODEX_SESSION_ID: 'explicit-session'}});
  t.after(() => child.forceDispose());
  assert.deepEqual(JSON.parse((await new FatalUtf8LineReader(child.stdout).nextLine())!),
    {session: 'explicit-session', pipe: null, home: 'fixture-home'});
  await child.forceDispose();
});
