import fs from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { verifyCaseData } from "./oracle.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_STANDARD = /^edge-canon\.next@[0-9a-f]{40}$/;
const PROBE_CASE_IDS = [
  "EC-STREAM-T001",
  "EC-STREAM-T002",
  "EC-STREAM-T003",
  "EC-STREAM-T004",
  "EC-STREAM-T009",
  "EC-STREAM-T011",
];

const VERIFIED_ASSERTIONS = [
  "EC-STREAM-T001",
  "EC-STREAM-T002",
  "EC-STREAM-T003/order-and-lock-release",
  "EC-STREAM-T004",
  "EC-STREAM-T006/streamed-response",
  "EC-STREAM-T009/stream-canary",
  "EC-STREAM-T010",
  "EC-STREAM-T011/runtime-byte-and-global-isolation",
];

const REMAINING_ASSERTIONS = [
  "EC-STREAM-T003/backpressure",
  "EC-STREAM-T005/source-error-cancel-abort",
  "EC-STREAM-T006/committed-body-error",
  "EC-STREAM-T007/waitUntil-all-settled",
  "EC-STREAM-T008/closed-registration",
  "EC-STREAM-T009/background-isolation",
  "EC-STREAM-T012/crash-loss-no-retry",
  "EC-STREAM-T011/source-policy",
  "EC-STREAM-T013/lock-and-provider-derivation",
];

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  requireValue(equal(Object.keys(value).sort(), [...keys].sort()), `${label} fields differ`);
}

function settlement(value, kind, name, code, label) {
  exactKeys(value, ["settlement", "name", "code"], label);
  requireValue(value.settlement === kind && value.name === name && value.code === code, `${label} settlement differs`);
}

function standardSettlement(value, kind, name, label) {
  exactKeys(value, ["settlement", "name", "code"], label);
  requireValue(value.settlement === kind && value.name === name, `${label} settlement differs`);
  requireValue(value.code === null || typeof value.code === "string", `${label} error code is invalid`);
}

function validateProbe(document, expectedLabel) {
  exactKeys(document, ["schemaVersion", "suiteId", "label", "caseData"], `${expectedLabel} probe`);
  requireValue(document.schemaVersion === 1 && document.suiteId === "EC-STREAM" && document.label === expectedLabel, `${expectedLabel} probe identity differs`);
  exactKeys(document.caseData, PROBE_CASE_IDS, `${expectedLabel} probe caseData`);

  verifyCaseData("EC-STREAM-T001", document.caseData["EC-STREAM-T001"]);
  verifyCaseData("EC-STREAM-T004", document.caseData["EC-STREAM-T004"]);

  const locks = document.caseData["EC-STREAM-T002"];
  exactKeys(locks, ["readableLocked", "writableLocked", "secondReader", "secondWriter", "oldReaderRead", "oldWriterWrite", "locksAfterRelease"], `${expectedLabel} T002 runtime data`);
  requireValue(locks.readableLocked === true && locks.writableLocked === true, `${expectedLabel} T002 locked flags differ`);
  standardSettlement(locks.secondReader, "throw", "TypeError", `${expectedLabel} T002 second reader`);
  standardSettlement(locks.secondWriter, "throw", "TypeError", `${expectedLabel} T002 second writer`);
  standardSettlement(locks.oldReaderRead, "reject", "TypeError", `${expectedLabel} T002 released reader`);
  standardSettlement(locks.oldWriterWrite, "reject", "TypeError", `${expectedLabel} T002 released writer`);
  requireValue(equal(locks.locksAfterRelease, { readable: false, writable: false }), `${expectedLabel} T002 release did not unlock streams`);

  const pipe = document.caseData["EC-STREAM-T003"];
  exactKeys(pipe, ["chunks", "pipeResult", "locksAfterPipe"], `${expectedLabel} T003 runtime data`);
  requireValue(equal(pipe.chunks, [[1], [2], [3]]), `${expectedLabel} T003 pipe order differs`);
  settlement(pipe.pipeResult, "fulfill", null, null, `${expectedLabel} T003 pipe result`);
  requireValue(equal(pipe.locksAfterPipe, { readable: false, writable: false }), `${expectedLabel} T003 retained locks`);

  const invocation = document.caseData["EC-STREAM-T009"];
  exactKeys(invocation, ["body", "waitUntilPresent", "waitUntilReturnedUndefined"], `${expectedLabel} T009 runtime data`);
  const canary = expectedLabel === "A" ? 0xaa : 0xbb;
  requireValue(equal(invocation.body, [[canary]]), `${expectedLabel} T009 stream canary differs`);
  requireValue(invocation.waitUntilPresent === true && invocation.waitUntilReturnedUndefined === true, `${expectedLabel} waitUntil surface differs`);

  const invalid = document.caseData["EC-STREAM-T011"];
  exactKeys(
    invalid,
    ["chunkFailures", "configuredTransform", "providerGlobals", "transformDescriptor", "constructorClosed", "functionPrototypeClosed"],
    `${expectedLabel} T011 runtime data`,
  );
  requireValue(equal(invalid.chunkFailures.map(({ variant }) => variant), ["string", "object"]), `${expectedLabel} T011 chunk variants differ`);
  for (const value of invalid.chunkFailures) {
    exactKeys(value, ["variant", "settlement", "name", "code"], `${expectedLabel} T011 ${value.variant}`);
    settlement(
      { settlement: value.settlement, name: value.name, code: value.code },
      "reject",
      "TypeError",
      "EC_STREAM_CHUNK_TYPE",
      `${expectedLabel} T011 ${value.variant}`,
    );
  }
  settlement(invalid.configuredTransform, "throw", "TypeError", "EC_STREAM_TRANSFORMER_NONPORTABLE", `${expectedLabel} configured TransformStream`);
  requireValue(equal(invalid.providerGlobals, ["WebSocket", "WebSocketPair", "WebSocketServer"].map((name) => ({
    name, type: "undefined", owned: true, writable: false, enumerable: false, configurable: false,
  }))), `${expectedLabel} provider global remains reflectively reachable`);
  requireValue(equal(invalid.transformDescriptor, { writable: false, enumerable: false, configurable: false }), `${expectedLabel} TransformStream global is mutable`);
  requireValue(invalid.constructorClosed === true && invalid.functionPrototypeClosed === true, `${expectedLabel} native TransformStream remains reflectively reachable`);
  return document;
}

function validateStream(value) {
  exactKeys(value, ["status", "contentType", "caseHeader", "body", "headersBeforeBodyEnd", "bodyDurationAfterHeadersMs", "replacementResponses"], "stream evidence");
  requireValue(value.status === 200 && value.contentType === "application/octet-stream", "T006 response metadata differs");
  requireValue(value.caseHeader === "EC-STREAM-T006" && equal(value.body, [1, 2, 3, 4]), "T006 streamed response differs");
  requireValue(value.headersBeforeBodyEnd === true && Number.isFinite(value.bodyDurationAfterHeadersMs) && value.bodyDurationAfterHeadersMs >= 25 && value.replacementResponses === 0, "T006 response was buffered or replaced");
}

function validateCapacity(value) {
  exactKeys(
    value,
    ["status", "contentType", "caseHeader", "bodyOctets", "bodySha256", "declaredChunkOctets", "declaredTotalOctets"],
    "capacity evidence",
  );
  requireValue(value.status === 200 && value.contentType === "application/octet-stream", "T010 response metadata differs");
  requireValue(value.caseHeader === "EC-STREAM-T010", "T010 case identity differs");
  requireValue(value.bodyOctets === 65_536 && value.declaredTotalOctets === 65_536 && value.declaredChunkOctets === 4_096, "T010 capacity boundary differs");
  requireValue(SHA256.test(value.bodySha256) && value.bodySha256 === "d1c4808f4915c05b0d32202151b6c8813fbc083ebf1846f0ab0f8df0fe31006e", "T010 capacity digest differs");
}

export function verifyProviderRuntimeEvidence(evidence) {
  exactKeys(evidence, ["schemaVersion", "standardVersion", "artifactSha256", "provider", "collectedAt", "probes", "stream", "capacity"], "provider runtime evidence");
  requireValue(evidence.schemaVersion === 1 && EXACT_STANDARD.test(evidence.standardVersion), "provider runtime standard identity differs");
  requireValue(SHA256.test(evidence.artifactSha256), "provider runtime artifact digest is invalid");
  requireValue(typeof evidence.collectedAt === "string" && Number.isFinite(Date.parse(evidence.collectedAt)), "provider runtime collection time is invalid");
  exactKeys(evidence.provider, ["id", "implementationVersion", "deploymentId"], "provider identity");
  for (const [key, value] of Object.entries(evidence.provider)) {
    requireValue(typeof value === "string" && value.length > 0, `provider ${key} is missing`);
  }
  requireValue(Array.isArray(evidence.probes) && evidence.probes.length === 2, "provider runtime requires exactly two probes");
  const byLabel = new Map(evidence.probes.map((document) => [document?.label, document]));
  requireValue(byLabel.size === 2 && byLabel.has("A") && byLabel.has("B"), "provider runtime probes must contain A and B once");
  validateProbe(byLabel.get("A"), "A");
  validateProbe(byLabel.get("B"), "B");
  validateStream(evidence.stream);
  validateCapacity(evidence.capacity);
  return {
    suiteId: "EC-STREAM",
    status: "runtime-partial-pass",
    verifiedAssertions: [...VERIFIED_ASSERTIONS],
    remainingAssertions: [...REMAINING_ASSERTIONS],
  };
}

function main(paths) {
  requireValue(paths.length === 1, "usage: node provider-runtime-oracle.mjs EVIDENCE.json");
  const evidence = JSON.parse(fs.readFileSync(paths[0], "utf8"));
  process.stdout.write(`${JSON.stringify(verifyProviderRuntimeEvidence(evidence), null, 2)}\n`);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`EC-STREAM provider runtime oracle failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
