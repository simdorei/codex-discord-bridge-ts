import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalTerminal, decodeTerminalProof, decodeOwnershipHandoff } from "../../src/store/async-resolution-proof.ts";
import { serializeSerdeValue, sha256SerdeValue } from "../../src/core/serde-json.ts";
const owner = {turn_id: "turn", observer: "resident", generation: 9007199254740993n, job: {}};
const row = {thread_id: "target", revision: 7n, claim_sha256: "claim"};
const metadata = {threadId: "target", turn: {id: "turn", status: "completed"}};
function proof(changes: Record<string, unknown> = {}): string {
  return serializeSerdeValue({version: 1n, source: "resident_notification_v1", observer: owner.observer,
    generation: owner.generation, thread_id: row.thread_id, turn_id: owner.turn_id, canonical_terminal: metadata,
    payload_sha256: sha256SerdeValue(metadata), claim_sha256: row.claim_sha256, revision: row.revision,
    owner_verified: true, ...changes});
}
test("terminal proof binds exact lossless owner, claim, revision and canonical digest", () => {
  assert.equal(decodeTerminalProof(row, owner, proof())?.generation, owner.generation);
  for (const [key, value] of Object.entries({version: 2n, source: "other", observer: "other", generation: 9007199254740992n,
    thread_id: "other", turn_id: "other", payload_sha256: "bad", claim_sha256: "bad", revision: 8n, owner_verified: false})) {
    assert.equal(decodeTerminalProof(row, owner, proof({[key]: value})), null, key);
  }
});
test("canonical terminal validates identity and only the three terminal statuses", () => {
  for (const status of ["completed", "failed", "interrupted"]) {
    assert.deepEqual(canonicalTerminal("target", "turn", JSON.stringify({...metadata, turn: {...metadata.turn, status}})),
      {...metadata, turn: {...metadata.turn, status}});
  }
  for (const value of [null, [], {}, {...metadata, threadId: "other"}, {...metadata, turn: {id: "turn", status: "running"}}]) {
    assert.throws(() => canonicalTerminal("target", "turn", JSON.stringify(value)));
  }
});
test("canonical digest excludes extra fields while accepted proof retains original metadata", () => {
  const extra = {...metadata, debug: "extra", turn: {...metadata.turn, metrics: 3n}};
  assert.deepEqual(decodeTerminalProof(row, owner, proof({canonical_terminal: extra}))?.canonical_terminal, extra);
});
test("invalid canonical evidence throws before stale metadata yields null", () => {
  assert.throws(() => decodeTerminalProof(row, owner, proof({version: 2n, canonical_terminal: {}})));
  assert.throws(() => decodeTerminalProof(row, owner, proof().replace('"version":1', '"version":1,"version":1')));
  assert.throws(() => decodeTerminalProof(row, owner, proof().replace('"revision":7', '"revision":7.0')));
});
test("unknown fields are ignored without relaxing known values", () => {
  const raw = proof().replace('{', '{"unknown":1e999,"unknown":"\\ud800",');
  assert.notEqual(decodeTerminalProof(row, owner, raw), null);
  assert.throws(() => decodeTerminalProof(row, owner, proof().replace('"observer":"resident"', '"observer":"\\ud800"')));
});
test("proof and canonical limits count UTF-8 bytes, including unknown fields", () => {
  assert.throws(() => decodeTerminalProof(row, owner, proof({noise: "한".repeat(44_000)})), /oversized terminal proof/);
  assert.throws(() => canonicalTerminal("target", "turn", JSON.stringify({...metadata, noise: "한".repeat(44_000)})), /bounded payload limit/);
  assert.notEqual(decodeTerminalProof(row, owner, proof({noise: "a".repeat(10_000)})), null);
});
test("handoff supports typed sequence and map forms with nested owner and rejects duplicate owner fields", () => {
  const fields = [1n, 7n, "claim", "prior", ["turn", owner.generation, "resident", {}]];
  const got = decodeOwnershipHandoff(serializeSerdeValue(fields));
  assert.equal(got.owner.generation, owner.generation); assert.equal(got.previous_terminal, "prior");
  const raw = serializeSerdeValue({version: 1n, revision: 7n, claim_sha256: "claim", previous_terminal: "prior", owner});
  assert.deepEqual(decodeOwnershipHandoff(raw), got);
  assert.throws(() => decodeOwnershipHandoff(raw.replace('"turn_id":"turn"', '"turn_id":"turn","turn_id":"turn"')));
});
