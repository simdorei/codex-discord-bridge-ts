import assert from "node:assert/strict";
import test from "node:test";
import { createResidentProtocolCodec, LIMITS_TEXT_MAX_BYTES, RESIDENT_PROTOCOL } from "../../src/runtime/resident-execution-protocol.ts";
import type { Limits, ResidentProtocolCodec } from "../../src/runtime/resident-execution-protocol.ts";

// Deliberately small synthetic fixtures, not production thresholds.
const limits: Limits = Object.freeze({
  maxEnvelopeBytes: 4096, maxReplyBytes: 4096, maxIdentifierBytes: 12, maxSequenceDigits: 24,
  maxAcceptedCommands: 8, maxQueuedCommands: 4, maxActiveCommands: 2, maxRegisteredIntents: 12,
  maxRetainedMetadataBytes: 4096, maxRetainedLogicalBytes: 8192, maxSingleIntentLogicalBytes: 1024,
  maxControlMessagesInFlight: 3, maxQueuedReplyBytes: 8192, maxProtocolMessagesPerWindow: 20, protocolWindowMs: 100,
});
const address = Object.freeze({ ownerEpoch: "epoch", sessionId: "session" });
const command = Object.freeze({ ...address, sequence: "1" });
const make = (patch: Partial<Limits> = {}): ResidentProtocolCodec => createResidentProtocolCodec(JSON.stringify({ ...limits, ...patch }), address.ownerEpoch, address.sessionId);
const request = (body: object, messageId = "message"): string => JSON.stringify({ protocol: RESIDENT_PROTOCOL, address, messageId, body });
const reply = (body: object): string => JSON.stringify({ protocol: RESIDENT_PROTOCOL, address, inReplyTo: "message", body });
const submit = Object.freeze({ kind: "submit", sequence: "1", intentId: "2", intentKind: "response", observedIntentRevision: "0" });
const accepted = [
  { kind: "pending", revision: "0", phase: "queued", cancellationRequested: false },
  { kind: "definitely-unsent", revision: "1", reason: "preparation-failed-before-start", custody: "confirmed", ownership: "joined" },
  { kind: "flushed", revision: "2", custody: "unknown", ownership: "retained" },
  { kind: "unknown", revision: "3", boundary: "owner-loss", ownership: "retained" },
];
const observations = [...accepted, ...["not-accepted", "not-seen", "retired-no-replay"].map(kind => ({ kind }))];
const reasons = ["inactive", "closing", "capacity", "intent-unavailable", "intent-mismatch", "intent-already-bound", "previously-rejected"];
const requestBodies = [submit, { kind: "reconcile", command }, { kind: "cancel", command }, { kind: "release-terminal-prefix", throughSequence: "0" }, { kind: "close", mode: "drain" }, { kind: "close", mode: "cancel-pending" }, { kind: "inspect" }];
const ownerStatus = {
  admission: "inactive", transportHealth: "connected", acceptedCount: "0", unresolvedCount: "0",
  retainedMetadataBytes: "0", retainedLogicalBytes: "0", lastSeenSequence: "0", retiredThroughSequence: "0",
};
const replyBodies = [
  ...["malformed", "unsupported-version", "oversize", "wrong-address", "sequence-gap", "rate-limited"].map(reason => ({ kind: "protocol-rejected", reason })),
  ...accepted.map(observation => ({ kind: "submission", command, disposition: { kind: "accepted", observation } })),
  ...reasons.map(reason => ({ kind: "submission", command, disposition: { kind: "not-accepted", reason } })),
  ...["identity-conflict", "retired-no-replay"].map(kind => ({ kind: "submission", command, disposition: { kind } })),
  ...observations.map(observation => ({ kind: "observation", command, observation })),
  ...accepted.map(observation => ({ kind: "cancel-result", command, status: "recorded", observation })),
  ...accepted.slice(1).map(observation => ({ kind: "cancel-result", command, status: "already-terminal", observation })),
  ...["not-accepted", "not-seen", "retired-no-replay"].map(kind => ({ kind: "cancel-result", command, status: kind, observation: { kind } })),
  ...["released", "blocked"].map(status => ({ kind: "release-result", throughSequence: "0", status })),
  { kind: "owner-status", status: ownerStatus },
];
function deeplyFrozen(value: unknown): void {
  if (value !== null && typeof value === "object") {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) deeplyFrozen(child);
  }
}
test("every closed request/reply/submission/observation variant round-trips with fresh recursive freezing", () => {
  const codec = make();
  for (const body of requestBodies) {
    const text = request(body), parsed = codec.decodeRequest(text);
    deeplyFrozen(parsed);
    assert.equal(codec.encodeRequest(parsed), text);
    assert.deepEqual(codec.decodeRequest(codec.encodeRequest(parsed)), parsed);
    assert.notEqual(codec.decodeRequest(text), parsed);
  }
  for (const body of replyBodies) {
    const text = reply(body), parsed = codec.decodeReply(text);
    deeplyFrozen(parsed);
    assert.equal(codec.encodeReply(parsed), text);
    assert.deepEqual(codec.decodeReply(codec.encodeReply(parsed)), parsed);
  }
  deeplyFrozen(codec);
});

test("every fixture field rejects deletion, unknown additions, and invalid type at every record depth", () => {
  const codec = make();
  const visit = (root: Record<string, unknown>, path: string[], decode: (text: unknown) => unknown): void => {
    let node = root;
    for (const key of path) node = node[key] as Record<string, unknown>;
    const cloneAt = (): [Record<string, unknown>, Record<string, unknown>] => {
      const copy = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
      let target = copy;
      for (const key of path) target = target[key] as Record<string, unknown>;
      return [copy, target];
    };
    const [extraRoot, extra] = cloneAt(); extra.unexpected = "extra";
    assert.throws(() => decode(JSON.stringify(extraRoot)), TypeError);
    for (const key of Object.keys(node)) {
      const [deletedRoot, deleted] = cloneAt(); delete deleted[key];
      assert.throws(() => decode(JSON.stringify(deletedRoot)), TypeError);
      const [nullRoot, nulled] = cloneAt(); nulled[key] = null;
      assert.throws(() => decode(JSON.stringify(nullRoot)), TypeError);
      if (typeof node[key] === "object") visit(root, [...path, key], decode);
      else {
        const [wrongRoot, wrong] = cloneAt(); wrong[key] = typeof node[key] === "boolean" ? "false" : false;
        assert.throws(() => decode(JSON.stringify(wrongRoot)), TypeError);
      }
    }
  };
  for (const body of requestBodies) visit(JSON.parse(request(body)) as Record<string, unknown>, [], codec.decodeRequest);
  for (const body of replyBodies) visit(JSON.parse(reply(body)) as Record<string, unknown>, [], codec.decodeReply);
});

test("raw text rejects duplicates including escape-equivalent keys, syntax, nesting and malformed Unicode", () => {
  const codec = make();
  const good = request(submit);
  for (const text of [
    good.replace('"messageId":"message"', '"messageId":"message","messageId":"other"'),
    good.replace('"messageId":"message"', '"messageId":"message","message\\u0049d":"other"'),
    good.replace('"sequence":"1"', '"sequence":"1","sequen\\u0063e":"1"'),
    good.replace('"body":{', '"body":{"kind":"submit",'),
    good + "x", "[{}]", "null", "42", '{"x":{"x":{"x":{"x":{}}}}}',
    good.replace('"message"', '"\\ud800"'), good.replace('"message"', '"\\udc00"'),
    good.replace('"message"', '"\ud800"'), good.replace('"message"', '"\udc00"'),
    good.replace('"message"', '"\\x41"'), good.replace('"message"', '"a\nb"'),
    good.replace('"sequence":"1"', '"sequence":1'), good.replace('"body":{', '"body":['),
    good.replace('"kind":"submit"', '"__proto__":"submit"'),
    good.replace('"kind":"submit"', '"constructor":"submit"'),
  ]) assert.throws(() => codec.decodeRequest(text), TypeError);
  const escaped = good.replace('"message"', '"mess\\u0061ge"');
  assert.equal(codec.encodeRequest(codec.decodeRequest(escaped)), good);
});

test("primitive-only API and private per-codec brands never inspect caller objects, accessors or proxies", () => {
  const codec = make();
  let touches = 0;
  const arbitrary = Object.defineProperty({}, "protocol", { get() { touches++; throw new Error("getter"); } });
  const proxy = new Proxy({}, { get() { touches++; throw new Error("get"); }, ownKeys() { touches++; throw new Error("keys"); }, getPrototypeOf() { touches++; throw new Error("prototype"); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const inputs: unknown[] = [arbitrary, proxy, revoked.proxy, new String(request(submit)), new Uint8Array([123, 125]), null, undefined, 0, Symbol("input"), () => "input"];
  const parsed = codec.decodeRequest(request(submit));
  const key = codec.commandKeyOf(parsed);
  for (const input of inputs) {
    for (const action of [
      () => codec.decodeRequest(input), () => codec.decodeReply(input), () => codec.encodeRequest(input), () => codec.encodeReply(input),
      () => codec.commandKeyOf(input), () => codec.compareCommandKeys(input, key), () => codec.compareCommandKeys(key, input),
      () => codec.sameSubmission(input, parsed), () => codec.sameSubmission(parsed, input),
      () => createResidentProtocolCodec(input, "epoch", "session"),
      () => createResidentProtocolCodec(JSON.stringify(limits), input, "session"),
      () => createResidentProtocolCodec(JSON.stringify(limits), "epoch", input),
    ]) assert.throws(action, TypeError);
  }
  assert.equal(touches, 0);
  assert.throws(() => codec.encodeRequest(JSON.parse(request(submit))), TypeError);
  const other = make();
  assert.throws(() => other.encodeRequest(parsed), TypeError);
  assert.throws(() => other.compareCommandKeys(key, key), TypeError);
  assert.throws(() => codec.encodeReply(parsed), TypeError);
  assert.throws(() => codec.commandKeyOf(codec.decodeRequest(request({ kind: "inspect" }))), TypeError);
  assert.throws(() => codec.sameSubmission(codec.decodeRequest(request({ kind: "inspect" })), parsed), TypeError);
});

test("canonical UInt values are bounded and lossless; positive sites reject zero and release accepts it", () => {
  const codec = make();
  for (const invalid of ["", "00", "01", "-1", "+1", "1.0", "1e2", " 1", "1 ", "١", "9".repeat(25)]) {
    for (const field of ["sequence", "intentId", "observedIntentRevision"]) assert.throws(() => codec.decodeRequest(request({ ...submit, [field]: invalid })), TypeError);
  }
  for (const field of ["sequence", "intentId"]) assert.throws(() => codec.decodeRequest(request({ ...submit, [field]: "0" })), TypeError);
  for (const kind of ["cancel", "reconcile"]) assert.throws(() => codec.decodeRequest(request({ kind, command: { ...command, sequence: "0" } })), TypeError);
  codec.decodeRequest(request({ kind: "release-terminal-prefix", throughSequence: "0" }));
  const sequence = "900719925474099312345678";
  const a = codec.decodeRequest(request({ ...submit, sequence }));
  const b = codec.decodeRequest(request({ ...submit, sequence: "900719925474099312345679" }));
  const c = codec.decodeRequest(request({ ...submit, sequence: "99999999999999999999999" }));
  assert.equal(codec.compareCommandKeys(codec.commandKeyOf(a), codec.commandKeyOf(b)), -1);
  assert.equal(codec.compareCommandKeys(codec.commandKeyOf(b), codec.commandKeyOf(a)), 1);
  assert.equal(codec.compareCommandKeys(codec.commandKeyOf(a), codec.commandKeyOf(c)), 1);
  assert.equal(codec.compareCommandKeys(codec.commandKeyOf(a), codec.commandKeyOf(a)), 0);
  assert.ok(codec.encodeRequest(a).includes(sequence));
  assert.ok(codec.sameSubmission(a, codec.decodeRequest(request({ ...submit, sequence }, "different"))));
  for (const [field, value] of [["sequence", "3"], ["intentId", "3"], ["intentKind", "mutation"], ["observedIntentRevision", "1"]]) {
    assert.equal(codec.sameSubmission(codec.decodeRequest(request(submit)), codec.decodeRequest(request({ ...submit, [field!]: value }))), false);
  }
});

test("exact version, ASCII identifiers and every construction-bound outer/nested address are enforced", () => {
  const codec = make();
  for (const value of ["", ".", "/tmp", "é", "😀", "a".repeat(13)]) {
    assert.throws(() => codec.decodeRequest(request(submit, value)), TypeError);
    assert.throws(() => createResidentProtocolCodec(JSON.stringify(limits), value, "session"), TypeError);
    assert.throws(() => createResidentProtocolCodec(JSON.stringify(limits), "epoch", value), TypeError);
  }
  codec.decodeRequest(request(submit, "a_-09AZ"));
  for (const field of ["ownerEpoch", "sessionId"]) {
    const wrong = { ...address, [field]: "different" };
    assert.throws(() => codec.decodeRequest(JSON.stringify({ protocol: RESIDENT_PROTOCOL, address: wrong, messageId: "message", body: submit })), TypeError);
    for (const kind of ["reconcile", "cancel"]) assert.throws(() => codec.decodeRequest(request({ kind, command: { ...command, [field]: "different" } })), TypeError);
    assert.throws(() => codec.decodeReply(reply({ kind: "observation", command: { ...command, [field]: "different" }, observation: accepted[0] })), TypeError);
    assert.throws(() => codec.decodeReply(JSON.stringify({ protocol: RESIDENT_PROTOCOL, address: wrong, inReplyTo: "message", body: replyBodies[0] })), TypeError);
  }
  assert.throws(() => codec.decodeRequest(request(submit).replace(RESIDENT_PROTOCOL, "persistent-resident-v2")), TypeError);
  for (const kind of ["open", "spawn", "restart", "force", "write", "call"]) assert.throws(() => codec.decodeRequest(request({ kind })), TypeError);
});

test("cancel-result admits exactly the reviewed status/observation pairs", () => {
  const codec = make();
  for (const status of ["recorded", "already-terminal", "not-accepted", "not-seen", "retired-no-replay"]) {
    for (const observation of observations) {
      const valid = status === "recorded" ? accepted.includes(observation as typeof accepted[number])
        : status === "already-terminal" ? accepted.slice(1).includes(observation as typeof accepted[number]) : observation.kind === status;
      const action = (): unknown => codec.decodeReply(reply({ kind: "cancel-result", command, status, observation }));
      if (valid) action(); else assert.throws(action, TypeError);
    }
  }
});

test("closed enum alternatives are accepted and arbitrary enum strings rejected", () => {
  const codec = make();
  for (const phase of ["queued", "preparing", "write-started", "settling"]) codec.decodeReply(reply({ kind: "observation", command, observation: { ...accepted[0], phase } }));
  for (const reason of ["cancelled-before-start", "closed-before-start", "authority-invalid-before-start", "preparation-failed-before-start"]) codec.decodeReply(reply({ kind: "observation", command, observation: { ...accepted[1], reason } }));
  for (const boundary of ["write", "custody", "owner-loss"]) codec.decodeReply(reply({ kind: "observation", command, observation: { ...accepted[3], boundary } }));
  for (const admission of ["inactive", "open", "closing", "closed"]) for (const transportHealth of ["connected", "disconnected"]) codec.decodeReply(reply({ kind: "owner-status", status: { ...ownerStatus, admission, transportHealth } }));
  for (const custody of ["confirmed", "unknown"]) for (const ownership of ["retained", "joined"]) codec.decodeReply(reply({ kind: "observation", command, observation: { ...accepted[2], custody, ownership } }));
  const rejectFields = [
    { ...accepted[0], phase: "else" }, { ...accepted[1], reason: "else" }, { ...accepted[2], custody: "else" },
    { ...accepted[2], ownership: "else" }, { ...accepted[3], boundary: "else" },
  ];
  for (const observation of rejectFields) assert.throws(() => codec.decodeReply(reply({ kind: "observation", command, observation })), TypeError);
  assert.throws(() => codec.decodeRequest(request({ ...submit, intentKind: "else" })), TypeError);
  assert.throws(() => codec.decodeRequest(request({ kind: "close", mode: "else" })), TypeError);
  assert.throws(() => codec.decodeReply(reply({ kind: "protocol-rejected", reason: "else" })), TypeError);
  assert.throws(() => codec.decodeReply(reply({ kind: "owner-status", status: { ...ownerStatus, admission: "else" } })), TypeError);
  assert.throws(() => codec.decodeReply(reply({ kind: "owner-status", status: { ...ownerStatus, transportHealth: "else" } })), TypeError);
});

test("all 15 limits are mandatory positive safe integer literals with closed construction schema", () => {
  for (const name of Object.keys(limits)) {
    const missing = { ...limits } as Record<string, unknown>; delete missing[name];
    assert.throws(() => createResidentProtocolCodec(JSON.stringify(missing), "epoch", "session"), TypeError);
    for (const invalid of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null, true]) assert.throws(() => make({ [name]: invalid } as Partial<Limits>), TypeError);
  }
  assert.throws(() => createResidentProtocolCodec(JSON.stringify({ ...limits, extra: 1 }), "epoch", "session"), TypeError);
  for (const token of ["01", "1e2", "1.0", "+1", "NaN", "Infinity", "99999999999999999"]) assert.throws(() => createResidentProtocolCodec(JSON.stringify(limits).replace('"protocolWindowMs":100', `"protocolWindowMs":${token}`), "epoch", "session"), TypeError);
  const duplicate = JSON.stringify(limits).replace('"protocolWindowMs":100', '"protocolWindowMs":100,"protocolWindowM\\u0073":100');
  assert.throws(() => createResidentProtocolCodec(duplicate, "epoch", "session"), TypeError);
  assert.throws(() => createResidentProtocolCodec(" ".repeat(LIMITS_TEXT_MAX_BYTES + 1), "epoch", "session"), RangeError);
  const config = JSON.stringify(limits);
  createResidentProtocolCodec(config + " ".repeat(LIMITS_TEXT_MAX_BYTES - config.length), "epoch", "session");
  for (const patch of [
    { maxIdentifierBytes: 4097 }, { maxActiveCommands: 9 }, { maxQueuedCommands: 9 }, { maxRegisteredIntents: 7 },
    { maxSingleIntentLogicalBytes: 8193 }, { maxSequenceDigits: 3 },
    { maxIdentifierBytes: Number.MAX_SAFE_INTEGER, maxEnvelopeBytes: Number.MAX_SAFE_INTEGER },
    { maxSequenceDigits: Number.MAX_SAFE_INTEGER },
  ]) assert.throws(() => make(patch), TypeError);
});

test("exact byte budgets, derived minima and informational maximum bounds remain separate", () => {
  const original = make();
  const { minimumEnvelopeBytes, minimumReplyBytes } = original.bounds;
  const codec = make({ maxEnvelopeBytes: minimumEnvelopeBytes, maxReplyBytes: minimumReplyBytes });
  assert.throws(() => make({ maxEnvelopeBytes: minimumEnvelopeBytes - 1 }), TypeError);
  assert.throws(() => make({ maxReplyBytes: minimumReplyBytes - 1 }), TypeError);
  assert.ok(codec.bounds.maximumEnvelopeBytes > minimumEnvelopeBytes);
  assert.ok(codec.bounds.maximumReplyBytes > minimumReplyBytes);
  const text = request({ kind: "inspect" });
  const exact = text + " ".repeat(minimumEnvelopeBytes - Buffer.byteLength(text));
  codec.decodeRequest(exact);
  assert.throws(() => codec.decodeRequest(exact + " "), RangeError);
  assert.throws(() => codec.decodeRequest(exact + " "+ "\ud800"), RangeError);
  // The extra multibyte string is rejected by byte budget before schema/ASCII checks.
  assert.throws(() => codec.decodeRequest(exact.slice(0, -2) + '"é"'), RangeError);
  const replyText = reply({ kind: "protocol-rejected", reason: "malformed" });
  codec.decodeReply(replyText + " ".repeat(minimumReplyBytes - replyText.length));
  assert.throws(() => codec.decodeReply(replyText + " ".repeat(minimumReplyBytes - replyText.length + 1)), RangeError);
  const maxId = "a".repeat(limits.maxIdentifierBytes), maxUInt = "9".repeat(limits.maxSequenceDigits);
  const wide = createResidentProtocolCodec(JSON.stringify(limits), maxId, maxId);
  const maxAddress = { ownerEpoch: maxId, sessionId: maxId };
  const maxCommand = { ...maxAddress, sequence: maxUInt };
  const maxRequest = JSON.stringify({ protocol: RESIDENT_PROTOCOL, address: maxAddress, messageId: maxId, body: { ...submit, sequence: maxUInt, intentId: maxUInt, observedIntentRevision: maxUInt } });
  assert.equal(Buffer.byteLength(maxRequest), wide.bounds.maximumEnvelopeBytes);
  wide.decodeRequest(maxRequest);
  const maxObservation = { kind: "definitely-unsent", revision: maxUInt, reason: "preparation-failed-before-start", custody: "confirmed", ownership: "retained" };
  const maxReply = JSON.stringify({ protocol: RESIDENT_PROTOCOL, address: maxAddress, inReplyTo: maxId, body: { kind: "submission", command: maxCommand, disposition: { kind: "accepted", observation: maxObservation } } });
  const maxStatusReply = JSON.stringify({ protocol: RESIDENT_PROTOCOL, address: maxAddress, inReplyTo: maxId, body: { kind: "owner-status", status: { ...ownerStatus, admission: "inactive", transportHealth: "disconnected", acceptedCount: maxUInt, unresolvedCount: maxUInt, retainedMetadataBytes: maxUInt, retainedLogicalBytes: maxUInt, lastSeenSequence: maxUInt, retiredThroughSequence: maxUInt } } });
  assert.equal(Math.max(Buffer.byteLength(maxReply), Buffer.byteLength(maxStatusReply)), wide.bounds.maximumReplyBytes);
  wide.decodeReply(maxReply); wide.decodeReply(maxStatusReply);
  const tight = createResidentProtocolCodec(JSON.stringify({ ...limits, maxEnvelopeBytes: minimumEnvelopeBytes, maxReplyBytes: minimumReplyBytes }), maxId, maxId);
  assert.throws(() => tight.decodeRequest(maxRequest), RangeError);
});

test("canonical encoding follows fixed schema order and diagnostics never reflect input", () => {
  const codec = make();
  const source = JSON.parse(request(submit)) as { protocol: string; address: object; messageId: string; body: object };
  const reordered = JSON.stringify({ body: { observedIntentRevision: "0", intentKind: "response", intentId: "2", sequence: "1", kind: "submit" }, messageId: source.messageId, address: { sessionId: address.sessionId, ownerEpoch: address.ownerEpoch }, protocol: source.protocol });
  assert.equal(codec.encodeRequest(codec.decodeRequest(reordered)), request(submit));
  for (const text of ["SECRET_input", '{"SECRET_input":', request({ kind: "SECRET_input" })]) {
    assert.throws(() => codec.decodeRequest(text), error => error instanceof TypeError && error.message === "Invalid resident protocol input");
  }
  assert.throws(() => codec.decodeRequest("SECRET_input".repeat(500)), error => error instanceof RangeError && error.message === "Resident protocol input exceeds limit");
});


test("null-prototype canonical records cannot observe inherited toJSON hooks", () => {
  const codec = make();
  const requestText = request(submit);
  const replyText = reply(replyBodies[0]!);
  const parsedRequest = codec.decodeRequest(requestText);
  const parsedReply = codec.decodeReply(replyText);
  let touches = 0;
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  try {
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true, get() { touches++; throw new Error("inherited hook"); } });
    assert.equal(codec.encodeRequest(parsedRequest), requestText);
    assert.equal(codec.encodeReply(parsedReply), replyText);
    assert.equal(codec.sameSubmission(parsedRequest, parsedRequest), true);
    const key = codec.commandKeyOf(parsedRequest);
    assert.equal(Object.getPrototypeOf(key), null);
    assert.equal(Object.getPrototypeOf(parsedRequest), null);
    assert.equal(Object.getPrototypeOf(parsedRequest.address), null);
    assert.equal(Object.getPrototypeOf(parsedRequest.body), null);
    assert.equal(touches, 0);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, "toJSON", previous);
    else Reflect.deleteProperty(Object.prototype, "toJSON");
  }
});

test("minimum control bound is attained by a valid exact cancel pair", () => {
  const fixture: Limits = { ...limits, maxSequenceDigits: 1, maxAcceptedCommands: 8, maxRegisteredIntents: 9, maxRetainedMetadataBytes: 9, maxRetainedLogicalBytes: 9, maxSingleIntentLogicalBytes: 1 };
  const maxId = "a".repeat(fixture.maxIdentifierBytes);
  const codec = createResidentProtocolCodec(JSON.stringify(fixture), maxId, maxId);
  const maxAddress = { ownerEpoch: maxId, sessionId: maxId };
  const text = JSON.stringify({ protocol: RESIDENT_PROTOCOL, address: maxAddress, inReplyTo: maxId, body: { kind: "cancel-result", command: { ...maxAddress, sequence: "1" }, status: "already-terminal", observation: { kind: "definitely-unsent", revision: "1", reason: "preparation-failed-before-start", custody: "confirmed", ownership: "retained" } } });
  assert.equal(Buffer.byteLength(text), codec.bounds.minimumReplyBytes);
  const tight = createResidentProtocolCodec(JSON.stringify({ ...fixture, maxReplyBytes: Buffer.byteLength(text) }), maxId, maxId);
  assert.equal(tight.encodeReply(tight.decodeReply(text)), text);
  assert.throws(() => createResidentProtocolCodec(JSON.stringify({ ...fixture, maxReplyBytes: Buffer.byteLength(text) - 1 }), maxId, maxId), TypeError);
});
