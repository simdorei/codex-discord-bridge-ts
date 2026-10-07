import test from "node:test";
import assert from "node:assert/strict";
import { ordinary } from "../../src/store/async-resolution-ordinary.ts";
import { parseSerdeValue } from "../../src/store/async-resolution-json-helpers.ts";

function runPlan(cmd: string, expected: boolean): void {
  const json = `{"version":1,"plan":{"Execute":${cmd}}}`;
  assert.equal(ordinary(parseSerdeValue(json)), expected);
}

function runCmd(cmd: string, expected: boolean): void {
  const json = `{"version":1,"command":${cmd}}`;
  assert.equal(ordinary(parseSerdeValue(json)), expected);
}

test("bare commands via plan Execute", () => {
  const BARE = [
    "Help", "Where", "Doctor", "Runners", "MirrorCheck", "QaButtons",
    "RestartCodex", "ForceRestartCodex", "Identity", "Resources", "Approval", "HostReboot",
  ];
  for (const name of BARE) {
    runPlan(JSON.stringify(name), true);
  }
  for (const bad of ["help", "where", "Unknown", "Stop", "Archive", ""]) {
    runPlan(JSON.stringify(bad), false);
  }
});

test("slash names via root command", () => {
  const SLASH = [
    "help", "list", "archived_list", "use", "status", "settings", "where",
    "context", "usage", "new", "ask", "interview", "doctor", "approval",
    "runners", "retract", "mirror_check", "bridge_sync", "qa_buttons",
  ];
  for (const name of SLASH) {
    runCmd(JSON.stringify(name), true);
  }
  for (const bad of ['"Help"', '"unknown"', "123", "null", "{}", "[]", "true"]) {
    runCmd(bad, false);
  }
});

test("object guards and wrapper malformations", () => {
  const cases: readonly [string, boolean][] = [
    ['{"Status":[]}', false],
    ['{"BridgeSync":null}', false],
    ['{"Status":123}', false],
    ['{"Status":"reference"}', false],
    ['{"List":[]}', false],
    ['{"List":null}', false],
    ["123", false],
    ["null", false],
    ["true", false],
    ["{}", false],
    ['{"Help":{},"Where":{}}', false],
    ['{"Ask":{"prompt":"a"},"New":{"prompt":"b"}}', false],
  ];
  for (const [cmd, expected] of cases) {
    runPlan(cmd, expected);
  }
});

test("DiscardRequest exact 1 field and canonical job_id", () => {
  const JOB = "b3d5a1a3-5c3e-4764-967b-0cef767efde9";
  const cases: readonly [string, boolean][] = [
    [`{"DiscardRequest":{"job_id":"${JOB}"}}`, true],
    [`{"DiscardRequest":{"job_id":"${JOB.toUpperCase()}"}}`, false],
    [`{"DiscardRequest":{"job_id":"${JOB}","extra":true}}`, false],
    ['{"DiscardRequest":{}}', false],
    [`{"DiscardRequest":{"request_id":"${JOB}"}}`, false],
    [`{"DiscardRequest":{"job_id":"${JOB.slice(0, 35)}"}}`, false],
    [`{"DiscardRequest":{"job_id":"${JOB}a"}}`, false],
    [`{"DiscardRequest":{"job_id":"${JOB.replace(/-/g, "")}"}}`, false],
    [`{"DiscardRequest":{"job_id":"${JOB.replace("-", "_")}"}}`, false],
    ['{"DiscardRequest":{"job_id":"z3d5a1a3-5c3e-4764-967b-0cef767efde9"}}', false],
    ['{"DiscardRequest":{"job_id":123}}', false],
    ['{"DiscardRequest":{"job_id":null}}', false],
  ];
  for (const [cmd, expected] of cases) {
    runPlan(cmd, expected);
  }
});

test("BridgeSync signed limit vs unsigned u32 boundaries", () => {
  const cases: readonly [string, boolean][] = [
    ['{"BridgeSync":{}}', true],
    ['{"BridgeSync":{"limit":null}}', true],
    ['{"BridgeSync":{"limit":0}}', true],
    ['{"BridgeSync":{"limit":-1}}', true],
    ['{"BridgeSync":{"limit":-9223372036854775808}}', true],
    ['{"BridgeSync":{"limit":9223372036854775807}}', true],
    ['{"BridgeSync":{"limit":"0"}}', false],
    ['{"BridgeSync":{"limit":1.5}}', false],
    ['{"BridgeSync":{"limit":9223372036854775808}}', false],
    ['{"BridgeSync":{"limit":-9223372036854775809}}', false],
    ['{"List":{"limit":0}}', true],
    ['{"List":{"limit":4294967295}}', true],
    ['{"List":{"limit":4294967296}}', false],
    ['{"List":{"limit":-1}}', false],
    ['{"List":{"limit":1.5}}', false],
    ['{"List":{"limit":"10"}}', false],
    ['{"List":{}}', false],
    ['{"Usage":{"days":0}}', true],
    ['{"Usage":{"days":4294967295}}', true],
    ['{"Usage":{"days":4294967296}}', false],
    ['{"Usage":{"days":-1}}', false],
    ['{"Usage":{"days":"7"}}', false],
    ['{"Usage":{}}', false],
    ['{"MirrorInspect":{"list":true}}', true],
    ['{"MirrorInspect":{"list":false,"limit":null}}', true],
    ['{"MirrorInspect":{"list":true,"limit":0}}', true],
    ['{"MirrorInspect":{"list":true,"limit":4294967295}}', true],
    ['{"MirrorInspect":{"list":true,"limit":-1}}', false],
    ['{"MirrorInspect":{"list":true,"limit":4294967296}}', false],
    ['{"MirrorInspect":{"limit":10}}', false],
    ['{"MirrorInspect":{"list":"true"}}', false],
    ['{"Context":{"all_threads":true,"refresh":false,"limit":0}}', true],
    ['{"Context":{"all_threads":false,"refresh":true,"limit":4294967295}}', true],
    ['{"Context":{"all_threads":true,"refresh":false,"limit":-1}}', false],
    ['{"Context":{"all_threads":true,"refresh":false,"limit":4294967296}}', false],
    ['{"Context":{"all_threads":true,"refresh":false}}', false],
    ['{"Context":{"all_threads":"true","refresh":false,"limit":10}}', false],
    ['{"Context":{"all_threads":true,"refresh":"false","limit":10}}', false],
  ];
  for (const [cmd, expected] of cases) {
    runPlan(cmd, expected);
  }
});

test("all nested command variants valid and wrong required/optional fields", () => {
  const cases: readonly [string, boolean][] = [
    ['{"Ask":{"prompt":"p"}}', true],
    ['{"Ask":{}}', false],
    ['{"Ask":{"prompt":1}}', false],
    ['{"New":{"prompt":"p"}}', true],
    ['{"New":{}}', false],
    ['{"Interview":{"prompt":"p"}}', true],
    ['{"Interview":{}}', false],
    ['{"Steer":{"prompt":"p"}}', true],
    ['{"Steer":{}}', false],
    ['{"ArchivedList":{"limit":10}}', true],
    ['{"ArchivedList":{}}', false],
    ['{"Use":{"reference":"ref"}}', true],
    ['{"Use":{}}', false],
    ['{"Use":{"reference":123}}', false],
    ['{"DeleteArchivePreview":{"reference":"ref"}}', true],
    ['{"DeleteArchivePreview":{}}', false],
    ['{"DeleteArchiveConfirm":{"reference":"ref"}}', true],
    ['{"DeleteArchiveConfirm":{}}', false],
    ['{"SavedRequest":{"request_id":"req-1"}}', true],
    ['{"SavedRequest":{}}', false],
    ['{"SavedRequest":{"request_id":null}}', false],
    ['{"Status":{}}', true],
    ['{"Status":{"reference":"ref"}}', true],
    ['{"Status":{"reference":null}}', true],
    ['{"Status":{"reference":123}}', false],
    ['{"Retract":{}}', true],
    ['{"Retract":{"reference":"ref"}}', true],
    ['{"Retract":{"reference":true}}', false],
    ['{"Recover":{}}', true],
    ['{"Recover":{"reference":"ref"}}', true],
    ['{"Recover":{"reference":123}}', false],
    ['{"Repair":{}}', true],
    ['{"Repair":{"reference":"ref"}}', true],
    ['{"Repair":{"reference":{}}}', false],
    ['{"Resume":{}}', true],
    ['{"Resume":{"reference":"ref"}}', true],
    ['{"Resume":{"reference":[]}}', false],
    ['{"Settings":{}}', true],
    ['{"Settings":{"reference":"r","model":"m","effort":"high","speed":"fast"}}', true],
    ['{"Settings":{"model":null,"speed":"fast"}}', true],
    ['{"Settings":{"model":123}}', false],
    ['{"Settings":{"effort":true}}', false],
    ['{"SettingsOptions":{}}', true],
    ['{"SettingsOptions":{"reference":"r","field":"model"}}', true],
    ['{"SettingsOptions":{"field":null}}', true],
    ['{"SettingsOptions":{"field":123}}', false],
    ['{"AutoReserve":{"enabled":true}}', true],
    ['{"AutoReserve":{"enabled":false,"reference":"ref"}}', true],
    ['{"AutoReserve":{"enabled":true,"reference":null}}', true],
    ['{"AutoReserve":{}}', false],
    ['{"AutoReserve":{"enabled":"true"}}', false],
    ['{"AutoReserve":{"enabled":true,"reference":123}}', false],
    ['{"Open":{"reference":"ref","abort":true}}', true],
    ['{"Open":{"reference":"ref","abort":false}}', true],
    ['{"Open":{"reference":"ref"}}', false],
    ['{"Open":{"abort":true}}', false],
    ['{"Open":{"reference":123,"abort":true}}', false],
    ['{"Open":{"reference":"ref","abort":"true"}}', false],
    ['{"Archive":{"reference":"target"}}', false],
    ['{"Stop":{"reference":"target"}}', false],
    ['{"UnknownCommand":{}}', false],
  ];
  for (const [cmd, expected] of cases) {
    runPlan(cmd, expected);
  }
});
