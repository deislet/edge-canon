import assert from "node:assert/strict";
import test from "node:test";
import { capabilityLock } from "./fixture.mjs";
import { verifyDocument } from "./oracle.mjs";
import {
  captureContractFailure,
  captureSourceFailure,
  createInvocationContext,
  deriveProviderConfiguration,
  validateCapabilityLock,
} from "./reference-runtime.mjs";
import { runSuite } from "./runner.mjs";

const STANDARD_VERSION = "edge-canon.next@0000000000000000000000000000000000000000";

test("EC-STREAM reference suite passes all thirteen cases", async () => {
  const observations = await runSuite({ standardVersion: STANDARD_VERSION });
  const result = verifyDocument(observations);
  assert.equal(result.status, "pass");
  assert.equal(result.caseIds.length, 13);
});

test("EC-STREAM oracle rejects a missing case", async () => {
  const observations = await runSuite({ standardVersion: STANDARD_VERSION });
  observations.cases.pop();
  assert.throws(() => verifyDocument(observations), /exactly thirteen/);
});

test("EC-STREAM oracle rejects crossed invocation stream evidence", async () => {
  const observations = await runSuite({ standardVersion: STANDARD_VERSION });
  const value = observations.cases.find((item) => item.id === "EC-STREAM-T009");
  value.data.bodies[0] = value.data.bodies[1];
  assert.throws(() => verifyDocument(observations), /crossed invocations/);
});

test("EC-STREAM capability lock rejects drift", () => {
  const lock = capabilityLock(STANDARD_VERSION);
  assert.equal(validateCapabilityLock(lock, STANDARD_VERSION), lock);
  const floating = structuredClone(lock);
  floating.standardVersion = "edge-canon.next@main";
  assert.equal(captureContractFailure(floating, STANDARD_VERSION), "EC_STREAM_STANDARD_PIN_INVALID");
  const expanded = structuredClone(lock);
  expanded.webSockets.portability = "required";
  assert.equal(captureContractFailure(expanded, STANDARD_VERSION), "EC_STREAM_WEBSOCKET_POLICY_INVALID");
});

test("EC-STREAM source policy rejects provider-only surfaces", () => {
  const empty = { providerGlobals: [], directStreamConstructors: [], transformersWithArguments: 0 };
  assert.equal(captureSourceFailure("new WebSocket('wss://example.com')", [], { ...empty, providerGlobals: ["WebSocket"] }), "EC_STREAM_WEBSOCKET_NONPORTABLE");
  assert.equal(captureSourceFailure("export default handler", ["new WebSocketPair()"], { ...empty, providerGlobals: ["WebSocketPair"] }), "EC_STREAM_WEBSOCKET_NONPORTABLE");
  assert.equal(captureSourceFailure("new TransformStream({ transform() {} })", [], { ...empty, transformersWithArguments: 1 }), "EC_STREAM_TRANSFORMER_NONPORTABLE");
});

test("EC-STREAM source policy consumes semantic analysis instead of identifier text", () => {
  const empty = { providerGlobals: [], directStreamConstructors: [], transformersWithArguments: 0 };
  const harmless = "type WebSocket = string; class WebSocketPair {}; const text = 'new WebSocket()';";
  assert.equal(captureSourceFailure(harmless, [], empty), null);
  assert.equal(captureSourceFailure("export default handler", [], undefined), "EC_STREAM_SOURCE_INVALID");
});

test("EC-STREAM waitUntil rejects work registered after close without executing its thenable", async () => {
  const context = createInvocationContext();
  await context.closeForeground();
  let executions = 0;
  const task = { then(resolve) { executions += 1; resolve(); } };
  assert.throws(() => context.waitUntil(task), (error) => error.code === "EC_WAIT_UNTIL_CLOSED");
  assert.equal(executions, 0);
});

test("EC-STREAM derives one portable policy for all first-class providers", () => {
  const lock = capabilityLock(STANDARD_VERSION);
  for (const provider of ["cloudflare-workers-pages", "tencent-edgeone-makers", "deislet"]) {
    const config = deriveProviderConfiguration(lock, provider);
    assert.equal(config.transform, "identity-byte-shim");
    assert.equal(config.waitUntil, "context-bound-all-settled");
    assert.equal(config.webSocket, "reject-nonportable");
  }
});
