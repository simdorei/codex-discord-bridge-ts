import {spawn} from 'node:child_process';
import {joinCurrentProcessJob} from './windows-process-job.ts';

// No provider code or inherited NODE_OPTIONS executes before job assignment.
// stdio is inherited directly by the provider; IPC is a separate control channel.
const name = process.argv[2], nonce = process.argv[3];
if (name === undefined || nonce === undefined || !process.connected || !process.send) throw new Error('Owned process bootstrap required');
process.on('disconnect', () => process.exit(1));
try {
  joinCurrentProcessJob(name);
  const timer = setTimeout(() => process.exit(1), 10000);
  process.once('message', (value: unknown) => {
    clearTimeout(timer);
    const message = value as {kind?: unknown; nonce?: unknown; executable?: unknown; arguments?: unknown; environment?: unknown};
    if (message?.kind !== 'launch' || message.nonce !== nonce || typeof message.executable !== 'string' ||
        !Array.isArray(message.arguments) || !message.arguments.every(arg => typeof arg === 'string') ||
        message.environment === null || typeof message.environment !== 'object') process.exit(1);
    const child = spawn(message.executable, message.arguments as string[], {
      stdio: ['inherit', 'inherit', 'inherit'], shell: false, windowsHide: true,
      env: message.environment as NodeJS.ProcessEnv,
    });
    child.once('error', () => { process.send?.({kind: 'failed', nonce}, () => process.exit(1)); });
    let reported = false, ended: number | undefined;
    child.once('spawn', () => { process.send?.({kind: 'started', nonce, pid: child.pid}, () => { reported = true; if (ended !== undefined) process.exit(ended); }); });
    child.once('exit', code => { ended = code ?? 1; if (reported) process.exit(ended); });
  });
  process.send({kind: 'ready', nonce});
} catch {
  process.send({kind: 'failed', nonce}, () => process.exit(1));
}
