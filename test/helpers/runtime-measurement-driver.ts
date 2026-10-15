import {parentPort} from 'node:worker_threads';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {WebSocketServer, type WebSocket} from 'ws';
import {remoteSocket} from './remote-runtime-fixture.ts';
import {monotonicNs, wireIdentity, type DriverInput, type DriverOutput, type MeasurementEvent} from './runtime-measurement.ts';

if (parentPort === null) throw new Error('Independent measurement driver requires a worker thread');
const port = parentPort;
const emit = (message: DriverOutput) => port.postMessage(message);
const event = (value: MeasurementEvent) => emit({kind: 'event', event: value});
let peer: WebSocket | undefined, closing = false, probeId = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();
const pendingProbes = new Set<number>();
const remote = await remoteSocket((connected, index) => {
  if (index !== 1) {event({kind: 'driver-failure', atNs: monotonicNs(), outcome: 'unexpected-reconnect'}); connected.close(); return;}
  peer = connected;
  connected.on('message', bytes => {
    const atNs = monotonicNs(), wire = bytes.toString();
    const value = JSON.parse(wire) as {type: string; request_id?: string; error_code?: string};
    if (value.type === 'hello') {
      connected.send('{"type":"hello_ack"}'); event({kind: 'remote-hello', atNs}); return;
    }
    if (typeof value.request_id !== 'string') {event({kind: 'driver-failure', atNs, outcome: 'unexpected-remote-message'}); return;}
    event({kind: 'result', atNs, requestId: value.request_id, resultType: value.type,
      ...(value.error_code === undefined ? {} : {errorCode: value.error_code}), ...wireIdentity(wire)});
  });
});
const gateway = new WebSocketServer({host: '127.0.0.1', port: 0, perMessageDeflate: false});
gateway.on('connection', connected => {
  connected.send('{"op":10,"d":{"heartbeat_interval":100}}');
  connected.on('message', raw => {
    const value = JSON.parse(raw.toString()) as {op: number};
    if (value.op === 1) {event({kind: 'gateway-heartbeat', atNs: monotonicNs()}); connected.send('{"op":11,"d":null}');}
  });
});
await once(gateway, 'listening');
const http = createServer((_request, response) => response.end(JSON.stringify({shards: 1, url: 'wss://gateway.discord.gg', session_start_limit: {max_concurrency: 1, remaining: 100, total: 100, reset_after: 0}})));
await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
const periodNs = 25000000n;
let nextProbe = process.hrtime.bigint();
function probe(): void {
  if (closing) return;
  const plannedNs = nextProbe.toString(), atNs = monotonicNs(), id = ++probeId;
  if (id > 4000) {event({kind: 'driver-failure', atNs, outcome: 'probe-budget-exhausted'}); return;}
  pendingProbes.add(id);
  event({kind: 'probe-sent', atNs, plannedNs, probeId: id});
  emit({kind: 'probe', probeId: id, plannedNs, atNs});
  // Advance from the original schedule. An overrun remains visible in lateness;
  // do not silently reset the clock to make a blocked observer look responsive.
  nextProbe += periodNs;
  const timer = setTimeout(() => {timers.delete(timer); probe();}, Math.max(0, Number(nextProbe - process.hrtime.bigint()) / 1e6));
  timers.add(timer);
}
probe();
port.on('message', (message: DriverInput) => {
  if (message.kind === 'probe-ack') {
    if (pendingProbes.delete(message.probeId)) event({kind: 'probe-ack', atNs: monotonicNs(), probeId: message.probeId, plannedNs: message.observedNs});
    return;
  }
  if (message.kind === 'close') {
    if (closing) return;
    closing = true;
    for (const timer of timers) clearTimeout(timer);
    void (async () => {
      await remote.close();
      for (const client of gateway.clients) client.terminate();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
      event({kind: 'driver-closed', atNs: monotonicNs(), outcome: `unacknowledged-probes:${pendingProbes.size}`});
      emit({kind: 'closed'}); port.close();
    })();
    return;
  }
  const anchor = process.hrtime.bigint() + 5000000n;
  message.wires.forEach((wire, index) => {
    const identity = wireIdentity(wire), requestId = (JSON.parse(wire) as {request_id: string}).request_id;
    const plannedNs = anchor + BigInt(index * message.spacingMs) * 1000000n;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (peer === undefined || peer.readyState !== 1) {event({kind: 'send-failure', atNs: monotonicNs(), requestId, outcome: 'socket-not-open'}); return;}
      const atNs = monotonicNs();
      peer.send(wire, error => event({kind: error == null ? 'send-completed' : 'send-failure', requestId, atNs: monotonicNs(), outcome: error == null ? 'callback-completed' : 'send-error'}));
      event({kind: 'injected', requestId, plannedNs: plannedNs.toString(), atNs, ...identity});
    }, Math.max(0, Number(plannedNs - process.hrtime.bigint()) / 1e6));
    timers.add(timer);
  });
});
emit({kind: 'ready', remoteUrl: remote.url, gatewayUrl: `ws://127.0.0.1:${(gateway.address() as {port: number}).port}/`, httpOrigin: `http://127.0.0.1:${(http.address() as {port: number}).port}/api/v10/`});
