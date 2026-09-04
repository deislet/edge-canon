import fs from "node:fs";
import { fileURLToPath } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_STANDARD = /^edge-canon\.next@[0-9a-f]{40}$/;
const EXPECTED_CASES = Array.from({ length: 13 }, (_, index) => `EC-STREAM-T${String(index + 1).padStart(3, "0")}`);

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

const VERIFIERS = {
  "EC-STREAM-T001"(data) {
    exactKeys(data, ["chunks", "expectedChunks", "terminal", "locksAfterRelease"], "T001 data");
    requireValue(equal(data.chunks, data.expectedChunks) && equal(data.chunks, [
      [101, 100, 103, 101], [45, 99, 97, 110, 111, 110], [45, 115, 116, 114, 101, 97, 109],
    ]), "T001 identity transform changed bytes or order");
    requireValue(equal(data.terminal, { done: true, value: null }), "T001 terminal read differs");
    requireValue(equal(data.locksAfterRelease, { readable: false, writable: false }), "T001 locks were not released");
  },
  "EC-STREAM-T002"(data) {
    exactKeys(data, ["readableLocked", "writableLocked", "secondReader", "secondWriter", "oldReaderRead", "oldWriterWrite", "locksAfterRelease"], "T002 data");
    requireValue(data.readableLocked === true && data.writableLocked === true, "T002 locked flags differ");
    settlement(data.secondReader, "throw", "TypeError", null, "T002 second reader");
    settlement(data.secondWriter, "throw", "TypeError", null, "T002 second writer");
    settlement(data.oldReaderRead, "reject", "TypeError", null, "T002 released reader");
    settlement(data.oldWriterWrite, "reject", "TypeError", null, "T002 released writer");
    requireValue(equal(data.locksAfterRelease, { readable: false, writable: false }), "T002 release did not unlock streams");
  },
  "EC-STREAM-T003"(data) {
    exactKeys(data, ["pipeTrace", "maximumInFlight", "pipeResult", "locksAfterPipe"], "T003 data");
    requireValue(equal(data.pipeTrace, ["start-1", "end-1", "start-2", "end-2", "start-3", "end-3", "close"]), "T003 pipe order differs");
    requireValue(data.maximumInFlight === 1, "T003 backpressure allowed concurrent writes");
    settlement(data.pipeResult, "fulfill", null, null, "T003 pipe result");
    requireValue(equal(data.locksAfterPipe, { readable: false, writable: false }), "T003 pipe retained locks");
  },
  "EC-STREAM-T004"(data) {
    exactKeys(data, ["left", "right", "streamsDistinct", "locksAfterRelease"], "T004 data");
    requireValue(equal(data.left, [[7], [8], [9]]) && equal(data.right, data.left), "T004 tee branches differ");
    requireValue(data.streamsDistinct === true && equal(data.locksAfterRelease, { left: false, right: false }), "T004 tee identity or lock isolation differs");
  },
  "EC-STREAM-T005"(data) {
    exactKeys(data, ["partial", "secondRead", "readerClosed", "cancel", "abort"], "T005 data");
    requireValue(equal(data.partial, [42]), "T005 first chunk differs");
    settlement(data.secondRead, "reject", "Error", null, "T005 second read");
    settlement(data.readerClosed, "reject", "Error", null, "T005 reader closed");
    requireValue(equal(data.cancel, { reason: "consumer-stop", count: 1 }) && equal(data.abort, { reason: "producer-stop", count: 1 }), "T005 cancel or abort did not propagate exactly once");
  },
  "EC-STREAM-T006"(data) {
    exactKeys(data, ["events", "body", "status", "committed"], "T006 data");
    requireValue(data.events[0] === "handler-settled" && data.events.at(-1) === "body-closed", "T006 foreground lifecycle ended before the body");
    requireValue(equal(data.body, [1, 2, 3, 4]) && data.status === 200, "T006 streamed response differs");
    exactKeys(data.committed, ["status", "terminal", "replacementResponses"], "T006 committed");
    requireValue(data.committed.status === 200 && data.committed.replacementResponses === 0, "T006 synthesized a replacement response");
    settlement(data.committed.terminal, "reject", "Error", null, "T006 committed body terminal");
  },
  "EC-STREAM-T007"(data) {
    exactKeys(data, ["completionOrder", "results", "response", "state"], "T007 data");
    requireValue(equal(data.completionOrder, ["second-rejected", "third", "first"]), "T007 tasks did not complete independently");
    requireValue(equal(data.results, [
      { status: "fulfilled", value: "first-value" },
      { status: "rejected", reasonName: "Error" },
      { status: "fulfilled", value: "third-value" },
    ]), "T007 all-settled association differs");
    requireValue(data.response === "response-stable" && data.state === "closed", "T007 rejection changed response or lifecycle state");
  },
  "EC-STREAM-T008"(data) {
    exactKeys(data, ["invalidPromise", "closedRegistration", "lateExecutions", "state"], "T008 data");
    settlement(data.invalidPromise, "throw", "TypeError", "EC_WAIT_UNTIL_PROMISE_REQUIRED", "T008 invalid Promise");
    settlement(data.closedRegistration, "throw", "TypeError", "EC_WAIT_UNTIL_CLOSED", "T008 closed registration");
    requireValue(data.lateExecutions === 0 && data.state === "closed", "T008 executed a task registered after close");
  },
  "EC-STREAM-T009"(data) {
    exactKeys(data, ["bodies", "tasks", "identities"], "T009 data");
    requireValue(equal(data.bodies, [[[170]], [[187]]]), "T009 stream canaries crossed invocations");
    requireValue(equal(data.tasks, [
      [{ status: "fulfilled", value: "task-a" }], [{ status: "fulfilled", value: "task-b" }],
    ]), "T009 background results crossed invocations");
    requireValue(equal(data.identities, { contextsDistinct: true, streamsDistinct: true }), "T009 contexts or streams share identity");
  },
  "EC-STREAM-T010"(data) {
    exactKeys(data, ["length", "sha256", "expectedSha256", "maximumChunk", "maximumOutstandingWrites"], "T010 data");
    requireValue(data.length === 65_536 && SHA256.test(data.sha256) && data.sha256 === data.expectedSha256, "T010 capacity bytes or digest differ");
    requireValue(data.maximumChunk === 4_096 && data.maximumOutstandingWrites === 1, "T010 chunk or outstanding write boundary differs");
  },
  "EC-STREAM-T011"(data) {
    exactKeys(data, ["chunkFailures", "sourceFailures", "allowedSurface", "isolatedGlobal"], "T011 data");
    requireValue(equal(data.chunkFailures.map((value) => value.variant), ["string", "object"]), "T011 chunk variants differ");
    for (const value of data.chunkFailures) settlement({ settlement: value.settlement, name: value.name, code: value.code }, "reject", "TypeError", "EC_STREAM_CHUNK_TYPE", `T011 ${value.variant}`);
    requireValue(equal(data.sourceFailures, [
      { variant: "websocket", code: "EC_STREAM_WEBSOCKET_NONPORTABLE" },
      { variant: "websocket-pair-dependency", code: "EC_STREAM_WEBSOCKET_NONPORTABLE" },
      { variant: "websocket-server", code: "EC_STREAM_WEBSOCKET_NONPORTABLE" },
      { variant: "readable-constructor", code: "EC_STREAM_DIRECT_CONSTRUCTOR_NONPORTABLE" },
      { variant: "transformer", code: "EC_STREAM_TRANSFORMER_NONPORTABLE" },
    ]), "T011 source rejection codes differ");
    requireValue(equal(data.allowedSurface, { applicationGlobals: ["TransformStream"], providerGlobals: [] }), "T011 provider global entered the application surface");
    requireValue(equal(data.isolatedGlobal, ["WebSocket", "WebSocketPair", "WebSocketServer"].map((name) => ({
      name, type: "undefined", owned: true, writable: false, enumerable: false, configurable: false,
    }))), "T011 provider global remains reflectively reachable");
  },
  "EC-STREAM-T012"(data) {
    exactKeys(data, ["attempts", "retries", "results", "lostTasks", "response", "abandonedState"], "T012 data");
    requireValue(data.attempts === 1 && data.retries === 0, "T012 background task was retried");
    requireValue(equal(data.results, [{ status: "rejected", reasonName: "Error" }]), "T012 rejection result differs");
    requireValue(data.lostTasks === 1 && data.response === "response-stable" && data.abandonedState === "closed", "T012 crash-loss or response semantics differ");
  },
  "EC-STREAM-T013"(data) {
    exactKeys(data, ["baselineDate", "mutations", "providers"], "T013 data");
    requireValue(data.baselineDate === "2026-09-04", "T013 baseline date differs");
    const expectedCodes = new Map([
      ["higher-major", "EC_STREAM_VERSION_UNSUPPORTED"],
      ["floating-standard", "EC_STREAM_STANDARD_PIN_INVALID"],
      ["unknown-field", "EC_STREAM_DOCUMENT_INVALID"],
      ["websocket-enabled", "EC_STREAM_WEBSOCKET_POLICY_INVALID"],
      ["websocket-global-exposed", "EC_STREAM_WEBSOCKET_POLICY_INVALID"],
    ]);
    requireValue(data.mutations.length === expectedCodes.size && data.mutations.every((value) => value.code === expectedCodes.get(value.variant) && value.applicationExecutions === 0), "T013 accepted a drifting lock");
    requireValue(equal(data.providers, [
      { providerId: "cloudflare-workers-pages", transform: "identity-byte-shim", waitUntil: "context-bound-all-settled", webSocket: "reject-nonportable", providerGlobalIsolation: "sealed-undefined-before-module-evaluation", nativeTransform: "IdentityTransformStream-or-compatible" },
      { providerId: "tencent-edgeone-makers", transform: "identity-byte-shim", waitUntil: "context-bound-all-settled", webSocket: "reject-nonportable", providerGlobalIsolation: "sealed-undefined-before-module-evaluation", nativeTransform: "TransformStream-no-arguments" },
      { providerId: "deislet", transform: "identity-byte-shim", waitUntil: "context-bound-all-settled", webSocket: "reject-nonportable", providerGlobalIsolation: "sealed-undefined-before-module-evaluation", nativeTransform: "edge-canon-runtime" },
    ]), "T013 provider policies differ");
  },
};

export function verifyDocument(document) {
  exactKeys(document, ["schemaVersion", "standardId", "suiteId", "backend", "artifactSha256", "cases"], "observation document");
  requireValue(document.schemaVersion === 1 && document.standardId === "edge-canon.next" && document.suiteId === "EC-STREAM", "observation identity differs");
  requireValue(SHA256.test(document.artifactSha256), "capability lock digest is invalid");
  exactKeys(document.backend, ["id", "implementationVersion", "standardVersion"], "backend");
  requireValue(document.backend.id === "edge-canon-reference-stream" && document.backend.implementationVersion === "edge-canon-reference-stream-harness/1", "reference backend identity differs");
  requireValue(EXACT_STANDARD.test(document.backend.standardVersion), "backend did not run an exact standard commit");
  requireValue(Array.isArray(document.cases), "cases must be an array");
  const byId = new Map();
  for (const item of document.cases) {
    exactKeys(item, ["id", "observedAt", "data", "evidenceRefs"], "case record");
    requireValue(!byId.has(item.id), `duplicate case ${item.id}`);
    requireValue(Number.isFinite(Date.parse(item.observedAt)), `${item.id} observedAt is invalid`);
    requireValue(Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0 && new Set(item.evidenceRefs).size === item.evidenceRefs.length, `${item.id} evidence references are invalid`);
    byId.set(item.id, item);
  }
  requireValue(byId.size === EXPECTED_CASES.length && EXPECTED_CASES.every((id) => byId.has(id)), "draft harness requires exactly thirteen stream cases");
  for (const id of EXPECTED_CASES) VERIFIERS[id](byId.get(id).data, document);
  return { suiteId: "EC-STREAM", status: "pass", caseIds: [...EXPECTED_CASES] };
}

function main(file) {
  requireValue(file, "usage: node oracle.mjs OBSERVATIONS.json");
  process.stdout.write(`${JSON.stringify(verifyDocument(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2)}\n`);
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  try { main(process.argv[2]); }
  catch (error) {
    process.stderr.write(`EC-STREAM oracle failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
