import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {renderActionUi, type RenderableActionUi} from '../../src/runtime/action-ui.ts';
import {busyButtonRow, approvalButtonRow, proBusyButtonRow, serializeDiscordComponent, ComponentError} from '../../src/discord/components.ts';
import {interactionUpdateRequestWithComponents, interactionUpdateRequest} from '../../src/discord/interaction-update-request.ts';
import {DiscordChannelClient} from '../../src/discord/channel-client.ts';
const choice = 'a'.repeat(24);
test('Busy keeps steer label distinction while ProBusy removes steer without changing remaining buttons', () => {
  const normal = renderActionUi({kind: 'Busy', choiceId: choice, allowSteer: false});
  assert.equal(serializeDiscordComponent(normal[0]!), serializeDiscordComponent(busyButtonRow(choice, false)));
  const pro = renderActionUi({kind: 'ProBusy', choiceId: choice});
  const parsed = JSON.parse(serializeDiscordComponent(pro[0]!));
  assert.deepEqual(parsed.components.map((v: {label: string}) => v.label), ['Queue next', 'Stop reply', 'Ignore']);
  assert.deepEqual(parsed.components, busyButtonRow(choice, false).components.filter(c => !c.custom_id.endsWith(':steer')));
  assert.equal(JSON.parse(serializeDiscordComponent(renderActionUi({kind: 'Busy', choiceId: choice, allowSteer: true})[0]!)).components[0].label, 'Steer now');
  assert.ok(Object.isFrozen(pro)); assert.ok(Object.isFrozen(pro[0])); assert.throws(() => proBusyButtonRow('invalid'), ComponentError);
});
test('ServerPrompts rendering flattens owned rows in order with exact zero/five/six boundary', () => {
  assert.deepEqual(renderActionUi(null), []);
  const a = busyButtonRow(choice, true), b = approvalButtonRow('thread');
  const ui = (rows: readonly (typeof a)[]): RenderableActionUi => ({kind: 'ServerPrompts', prompts: [{prompt: {components: rows}}]});
  assert.deepEqual(renderActionUi(ui([])), []); assert.deepEqual(renderActionUi(ui([a, b, a, b, a])), [a, b, a, b, a]);
  assert.throws(() => renderActionUi(ui([a, b, a, b, a, b])), ComponentError);
  assert.deepEqual(renderActionUi({kind: 'ServerPrompts', prompts: [{prompt: {components: [a]}}, {prompt: {components: [b]}}]}), [a, b]);
});
test('rendering captures arrays without reading unrelated request/authority properties', () => {
  let hooks = 0; const rows = [busyButtonRow(choice, true)];
  const prompt = {prompt: {components: rows}, get request() {hooks++; throw new Error('unrelated');}};
  const rendered = renderActionUi({kind: 'ServerPrompts', prompts: [prompt]}); rows.length = 0;
  assert.equal(rendered.length, 1); assert.equal(hooks, 0);
});
test('unowned components and active UI fields are rejected without executing getters/proxy traps', () => {
  let hooks = 0;
  assert.throws(() => renderActionUi({get kind() {hooks++; return 'ProBusy';}} as RenderableActionUi));
  assert.throws(() => renderActionUi(new Proxy({}, {getOwnPropertyDescriptor() {hooks++; throw new Error('trap');}}) as RenderableActionUi));
  assert.throws(() => renderActionUi({kind: 'ServerPrompts', prompts: [{prompt: {components: [{type: 1, components: []}]}}]}), ComponentError);
  assert.equal(hooks, 0);
});
test('component update emits source field order; empty component list preserves existing buttons', () => {
  const rows = [proBusyButtonRow(choice)], request = interactionUpdateRequestWithComponents(4n, 'offline_token', 'busy', rows);
  assert.equal(request.body, `{"allowed_mentions":{"parse":[]},"components":[${serializeDiscordComponent(rows[0]!)}],"content":"busy"}`);
  assert.deepEqual(interactionUpdateRequestWithComponents(4n, 'offline_token', 'busy', []), interactionUpdateRequest(4n, 'offline_token', 'busy'));
  rows.length = 0; assert.equal(JSON.parse(request.body).components.length, 1);
  // Source builder does not apply the separate ActionUi ServerPrompts row cap.
  assert.equal(JSON.parse(interactionUpdateRequestWithComponents(4n, 'offline_token', '', Array(6).fill(proBusyButtonRow(choice))).body).components.length, 6);
});
test('native component PATCH uses captured source-owned UI without bot credentials', async () => {
  const seen: unknown[] = [], server = createServer((req, res) => {let raw = ''; req.on('data', b => {raw += b;}); req.on('end', () => {
    seen.push([req.method, req.url, req.headers.authorization, JSON.parse(raw)]); res.statusCode = 204; res.end();
  });});
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const client = await DiscordChannelClient.create({token: null, testOrigin: `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v10/`, report: () => {}});
  try {
    const rows = [...renderActionUi({kind: 'ProBusy', choiceId: choice})], expected = rows.map(row => JSON.parse(serializeDiscordComponent(row)));
    const task = client.updateInitialResponseWithComponents(4n, 'offline_token', 'busy', rows); rows.length = 0; await task;
    assert.deepEqual(seen, [['PATCH', '/api/v10/webhooks/4/offline_token/messages/@original', undefined, {allowed_mentions: {parse: []}, components: expected, content: 'busy'}]]);
  } finally {await client.close(); server.closeAllConnections(); await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); assert.equal(client.activeRequests, 0); assert.equal(client.ownedSockets, 0);}
});
