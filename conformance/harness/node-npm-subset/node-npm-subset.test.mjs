import assert from "node:assert/strict";
import test from "node:test";
import { capabilityLock, IMPORT_CONDITIONS, syntheticPackage } from "./fixture.mjs";
import { verifyDocument } from "./oracle.mjs";
import { captureFailure, deriveProviderConfiguration, resolveConditionalTarget, sha512Integrity, validateApplicationSource, validateCapabilityLock, validatePackage } from "./reference-runtime.mjs";
import { runSuite } from "./runner.mjs";

const STANDARD_VERSION = "edge-canon.next@0000000000000000000000000000000000000000";

test("EC-NODE reference suite passes all fifteen cases under the exact semantic runtime", async () => {
  const observations = await runSuite({ standardVersion: STANDARD_VERSION });
  const result = verifyDocument(observations);
  assert.equal(result.status, "pass");
  assert.equal(result.caseIds.length, 15);
});

test("EC-NODE oracle rejects a missing case", async () => {
  const observations = await runSuite({ standardVersion: STANDARD_VERSION });
  observations.cases.pop();
  assert.throws(() => verifyDocument(observations), /exactly fifteen/);
});

test("EC-NODE oracle rejects a missing builtin export", async () => {
  const observations = await runSuite({ standardVersion: STANDARD_VERSION });
  observations.cases[0].data.inventory[0].missing.push("ok");
  assert.throws(() => verifyDocument(observations), /missing or extra selected export/);
});

test("EC-NODE lock rejects API and condition drift", () => {
  const lock = capabilityLock(STANDARD_VERSION);
  assert.equal(validateCapabilityLock(lock, STANDARD_VERSION), lock);
  const expanded = structuredClone(lock); expanded.node.builtinModules["node:path"].push("extra");
  assert.equal(captureFailure(() => validateCapabilityLock(expanded, STANDARD_VERSION)), "EC_NODE_API_SET_INVALID");
  const reordered = structuredClone(lock); reordered.modules.importConditions.reverse();
  assert.equal(captureFailure(() => validateCapabilityLock(reordered, STANDARD_VERSION)), "EC_NODE_CONDITIONS_INVALID");
});

test("EC-NODE conditional resolution follows Node package declaration order", () => {
  assert.equal(
    resolveConditionalTarget({ default: "./default.mjs", "edge-canon": "./edge.mjs" }, IMPORT_CONDITIONS),
    "./default.mjs",
  );
  assert.equal(
    resolveConditionalTarget({ unknown: "./unknown.mjs", "edge-canon": "./edge.mjs", default: "./default.mjs" }, IMPORT_CONDITIONS),
    "./edge.mjs",
  );
});

test("EC-NODE source policy rejects host control and dynamic resolution", () => {
  assert.equal(captureFailure(() => validateApplicationSource("import { spawn } from 'node:child_process'")), "EC_NODE_BUILTIN_UNSUPPORTED");
  assert.equal(captureFailure(() => validateApplicationSource("require(packageName)")), "EC_NPM_DYNAMIC_RESOLUTION_UNSUPPORTED");
});

test("EC-NODE package policy rejects hooks, native addons and integrity drift", () => {
  const bytes = Uint8Array.from([1, 2, 3]);
  const base = syntheticPackage(1, bytes, sha512Integrity(bytes));
  assert.equal(validatePackage(base), base);
  assert.equal(captureFailure(() => validatePackage({ ...base, scripts: { install: "node-gyp rebuild" } })), "EC_NPM_LIFECYCLE_SCRIPT_UNSUPPORTED");
  assert.equal(captureFailure(() => validatePackage({ ...base, files: ["binding.node"] })), "EC_NPM_NATIVE_ADDON_UNSUPPORTED");
  assert.equal(captureFailure(() => validatePackage({ ...base, bytes: Uint8Array.from([9]) })), "EC_NPM_INTEGRITY_FAILED");
});

test("EC-NODE derives the same application surface through appropriate provider executors", () => {
  const lock = capabilityLock(STANDARD_VERSION);
  const configs = ["cloudflare-workers-pages", "tencent-edgeone-makers", "deislet"].map((provider) => deriveProviderConfiguration(lock, provider));
  assert.equal(new Set(configs.map((value) => value.surfaceIdentity)).size, 1);
  assert.deepEqual(configs.map((value) => value.executor), ["workers-native-plus-verified-shims", "cloud-functions-api-node", "deislet-node-compat-layer"]);
});
