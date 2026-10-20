import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer, type ServerResponse} from 'node:http';
import {promptFixture, editPromptFixture} from '../helpers/server-prompt-fixture.ts';
import {prepareServerPrompts, PromptRedisplayChangedError} from '../../src/runtime/server-prompt-redisplay.ts';
import {deliverServerPrompts} from '../../src/runtime/server-prompt-delivery.ts';
import {DiscordChannelClient} from '../../src/discord/channel-client.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {parseSerdeValue} from '../../src/core/serde-json-parse.ts';
import {ServerRequestOccurrence} from '../../src/protocol/ids.ts';
const longInput = {method: 'item/tool/requestUserInput', params: {threadId: 't', turnId: 'v', questions: [{id: 'q', question: 'x'.repeat(5000), options: [{label: 'One'}, {label: 'Two'}]}]}};
async function httpFixture(run: (client: DiscordChannelClient, seen: {path: string; body: any}[]) => Promise<void>, handler?: (count: number, res: ServerResponse) => Promise<void>) {
  const seen: {path: string; body: any}[] = [], tasks: Promise<void>[] = [], errors: unknown[] = [];
  const server = createServer((req, res) => {let raw = ''; req.on('data', b => {raw += b;}); req.on('end', () => {
    seen.push({path: req.url!, body: JSON.parse(raw)}); tasks.push(Promise.resolve().then(async () => {
      assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, undefined);
      if (handler) await handler(seen.length, res);
      if (!res.writableEnded) res.end(JSON.stringify({attachments: [], author: {id: '1', username: 'fixture', discriminator: '0'}, channel_id: '1', content: '', embeds: [], id: String(100 + seen.length), type: 0,
        mention_everyone: false, mention_roles: [], mentions: [], pinned: false, timestamp: '2020-01-01T00:00:00+00:00', tts: false}));
    }).catch(error => {errors.push(error); res.statusCode = 500; res.end('{}');}));
  });});
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const client = await DiscordChannelClient.create({token: null, testOrigin: `http://127.0.0.1:${(server.address() as {port: number}).port}/api/v10/`, report: () => {}});
  try {await run(client, seen); await Promise.all(tasks); assert.deepEqual(errors, []);} finally {await client.close(); await Promise.all(tasks); server.closeAllConnections();
    await new Promise<void>((r, j) => server.close(e => e ? j(e) : r())); assert.equal(client.activeRequests, 0); assert.equal(client.ownedSockets, 0);}
}
test('native redisplay delivery has exact occurrence-array receipt identity and skips confirmed repeats', {timeout: 10000}, async () => {
  await promptFixture(async (path, server) => {const prompts = await prepareServerPrompts(path, server, 't', 1n, 2n);
    await httpFixture(async (http, seen) => {
      const context = {database: path, server, http, channelId: 1n, userId: 2n, commandKey: 'original-command'};
      await deliverServerPrompts(context, prompts); await deliverServerPrompts(context, prompts); assert.equal(seen.length, 1);
      const db = await openInitialized(path); try {
        const rows = db.prepare('SELECT receipt_key,message_id FROM codex_delivery_receipts').all(); assert.equal(rows.length, 1);
        const tuple = parseSerdeValue<unknown[]>(rows[0]!.receipt_key as string), bytes = Array.from(ServerRequestOccurrence.prototype.asBytes.call(prompts[0]!.request.occurrence));
        assert.deepEqual(tuple.slice(0, 2), [1n, 'server-request/redisplay/v1']);
        assert.equal(tuple[2], `["original-command",1,"approval",${JSON.stringify(bytes)}]`); assert.equal(tuple[3], 0n); assert.equal(rows[0]!.message_id, '101');
      } finally {db.close();}
      assert.equal(server.pendingServerRequests('t').length, 1);
    });
  });
});
test('long prompt is separately receipted per chunk with components only on final message', {timeout: 10000}, async () => {
  await promptFixture(async (path, server) => {const prompts = await prepareServerPrompts(path, server, 't', 1n, 2n);
    await httpFixture(async (http, seen) => {
      await deliverServerPrompts({database: path, server, http, channelId: 1n, userId: 2n, commandKey: 'long'}, prompts);
      assert.ok(seen.length >= 3); assert.ok(seen.every(v => v.path === '/api/v10/channels/1/messages'));
      for (const item of seen.slice(0, -1)) assert.equal(item.body.components, undefined);
      assert.equal(seen.at(-1)!.body.components.length, 1);
      const db = await openInitialized(path); try {assert.equal(db.prepare('SELECT count(*) AS n FROM codex_delivery_receipts WHERE message_id IS NOT NULL').get()!.n, seen.length);} finally {db.close();}
    });
  }, longInput);
});
test('mapping change after first chunk stops before any later chunk or button delivery', {timeout: 10000}, async () => {
  await promptFixture(async (path, server) => {const prompts = await prepareServerPrompts(path, server, 't', 1n, 2n);
    await httpFixture(async (http, seen) => {
      await assert.rejects(deliverServerPrompts({database: path, server, http, channelId: 1n, userId: 2n, commandKey: 'changed'}, prompts), PromptRedisplayChangedError);
      assert.equal(seen.length, 1); assert.equal(seen[0]!.body.components, undefined);
    }, async count => {if (count === 1) await editPromptFixture(path, "UPDATE mirror_threads SET codex_thread_id='other'");});
  }, longInput);
});
test('stale prepared actor or restart state never sends stored authorized UI', {timeout: 10000}, async () => {
  await promptFixture(async (path, server) => {const prompts = await prepareServerPrompts(path, server, 't', 1n, 2n);
    await httpFixture(async (http, seen) => {
      const context = {database: path, server, http, channelId: 1n, userId: 99n, commandKey: 'wrong-actor'};
      await assert.rejects(deliverServerPrompts(context, prompts), PromptRedisplayChangedError);
      server.requestRestart(); await assert.rejects(deliverServerPrompts({...context, userId: 2n}, prompts), PromptRedisplayChangedError); assert.equal(seen.length, 0);
    });
  });
});
test('unchanged unavailable diagnostic may be delivered without private contents or authorization UI', {timeout: 10000}, async () => {
  await promptFixture(async (path, server) => {const prompts = await prepareServerPrompts(path, server, 't', 1n, 99n); assert.equal(prompts[0]!.unavailable, true);
    await httpFixture(async (http, seen) => {
      await deliverServerPrompts({database: path, server, http, channelId: 1n, userId: 99n, commandKey: 'diagnostic'}, prompts);
      assert.equal(seen.length, 1); assert.equal(seen[0]!.body.components, undefined); assert.equal(seen[0]!.body.content.includes('PRIVATE_REASON'), false);
    });
  }, {params: {threadId: 't', turnId: 'v', reason: 'PRIVATE_REASON'}});
});
test('malformed message receipt leaves unknown outcome and repeat cannot resend', {timeout: 10000}, async () => {
  await promptFixture(async (path, server) => {const prompts = await prepareServerPrompts(path, server, 't', 1n, 2n);
    await httpFixture(async (http, seen) => {
      const context = {database: path, server, http, channelId: 1n, userId: 2n, commandKey: 'unknown'};
      await assert.rejects(deliverServerPrompts(context, prompts), /outcome unconfirmed/);
      await assert.rejects(deliverServerPrompts(context, prompts), /outcome unknown/); assert.equal(seen.length, 1);
    }, async (_count, res) => {res.end('{"id":"123"}');});
  });
});
test('copied/forged prepared objects are rejected before HTTP and mutable list cannot append new sends', {timeout: 10000}, async () => {
  await promptFixture(async (path, server) => {const prompts = await prepareServerPrompts(path, server, 't', 1n, 2n);
    await httpFixture(async (http, seen) => {
      const context = {database: path, server, http, channelId: 1n, userId: 2n, commandKey: 'capture'};
      await assert.rejects(deliverServerPrompts(context, [{...prompts[0]!}]), TypeError); assert.equal(seen.length, 0);
      const values = [...prompts], task = deliverServerPrompts(context, values); values.push(prompts[0]!); context.channelId = 99n; await task;
      assert.equal(seen.length, 1); assert.equal(seen[0]!.path, '/api/v10/channels/1/messages');
    });
  });
});
