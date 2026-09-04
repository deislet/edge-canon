import fs from "node:fs";
import { pathToFileURL } from "node:url";

const EXPECTED_CASES = [
  "EC-WEB-T001",
  "EC-WEB-T002",
  "EC-WEB-T003",
  "EC-WEB-T004",
  "EC-WEB-T005",
  "EC-WEB-T006",
  "EC-WEB-T007",
  "EC-WEB-T008",
  "EC-WEB-T009",
  "EC-WEB-T010",
  "EC-WEB-T011",
  "EC-WEB-T012",
  "EC-WEB-T013",
  "EC-WEB-T014",
];
const ERROR_BODY = "Internal Server Error\n";
const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_STANDARD_VERSION = /^edge-canon\.next@[0-9a-f]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  requireValue(JSON.stringify(actual) === JSON.stringify(expected), `${label} keys differ: ${actual.join(",")}`);
}

function standardError(attempt, expectedMode, expectedCode) {
  exactKeys(
    attempt,
    ["mode", "status", "contentType", "cacheControl", "body", "failureCode", "originHitCount", "leakedSentinel"],
    `${expectedMode} error observation`,
  );
  requireValue(attempt.mode === expectedMode, `missing ${expectedMode} attempt`);
  requireValue(attempt.status === 500, `${expectedMode} status must be 500`);
  requireValue(attempt.contentType.toLowerCase() === "text/plain; charset=utf-8", `${expectedMode} content type differs`);
  requireValue(attempt.cacheControl.toLowerCase() === "no-store", `${expectedMode} cache control differs`);
  requireValue(attempt.body === ERROR_BODY, `${expectedMode} body differs`);
  requireValue(attempt.failureCode === expectedCode, `${expectedMode} failure code differs`);
  requireValue(attempt.originHitCount === 0, `${expectedMode} fell through to origin`);
  requireValue(attempt.leakedSentinel === false, `${expectedMode} leaked the exception sentinel`);
}

const VERIFIERS = {
  "EC-WEB-T001"(data) {
    exactKeys(data, ["buildSucceeded", "defaultEntrypointCount", "status", "body"], "T001 data");
    requireValue(data.buildSucceeded === true, "T001 build did not succeed");
    requireValue(data.defaultEntrypointCount === 1, "T001 must expose exactly one default entrypoint");
    requireValue(data.status === 200 && data.body === "edge-canon-sync", "T001 response differs");
  },
  "EC-WEB-T002"(data) {
    exactKeys(data, ["status", "contextKeys", "contextObjectIdentityUnique", "environment", "parameter", "backgroundEvidence"], "T002 data");
    requireValue(data.status === 200, "T002 response status differs");
    requireValue(
      JSON.stringify(data.contextKeys) === JSON.stringify(["env", "params", "request", "waitUntil"]),
      "T002 context keys differ",
    );
    requireValue(data.contextObjectIdentityUnique === true, "T002 context object was reused");
    requireValue(data.environment === "edge-canon-env" && data.parameter === "edge-canon-param", "T002 injected values differ");
    requireValue(data.backgroundEvidence === "background-complete", "T002 background task did not complete");
  },
  "EC-WEB-T003"(data) {
    exactKeys(data, ["entrypointCount", "exchanges"], "T003 data");
    requireValue(data.entrypointCount === 1, "T003 methods used different entrypoints");
    const expected = [
      ["GET", "", "GET:"],
      ["POST", "post-body", "POST:post-body"],
      ["PURGE", "purge-body", "PURGE:purge-body"],
    ];
    requireValue(Array.isArray(data.exchanges) && data.exchanges.length === expected.length, "T003 exchanges differ");
    for (let index = 0; index < expected.length; index += 1) {
      const exchange = data.exchanges[index];
      exactKeys(exchange, ["method", "requestBody", "responseBody"], `T003 exchange ${index}`);
      requireValue(
        exchange.method === expected[index][0]
          && exchange.requestBody === expected[index][1]
          && exchange.responseBody === expected[index][2],
        `T003 exchange ${index} differs`,
      );
    }
  },
  "EC-WEB-T004"(data) {
    exactKeys(data, ["attempts"], "T004 data");
    requireValue(Array.isArray(data.attempts) && data.attempts.length === 2, "T004 needs two attempts");
    standardError(data.attempts[0], "sync", "EC_HANDLER_THROWN");
    standardError(data.attempts[1], "async", "EC_HANDLER_THROWN");
  },
  "EC-WEB-T005"(data) {
    exactKeys(data, ["attempts"], "T005 data");
    requireValue(Array.isArray(data.attempts) && data.attempts.length === 3, "T005 needs three attempts");
    for (const [index, mode] of ["undefined", "string", "object"].entries()) {
      standardError(data.attempts[index], mode, "EC_HANDLER_RESULT_INVALID");
    }
  },
  "EC-WEB-T006"(data) {
    exactKeys(
      data,
      ["completionOrder", "moduleCounterSamples", "orderingAssertionApplied", "responses"],
      "T006 data",
    );
    requireValue(Array.isArray(data.responses) && data.responses.length >= 8, "T006 needs at least eight concurrent responses");
    const markers = [];
    for (const [index, response] of data.responses.entries()) {
      exactKeys(response, ["contextObjectIdentityUnique", "requestMarker", "responseMarker"], `T006 response ${index}`);
      requireValue(response.contextObjectIdentityUnique === true, `T006 response ${index} reused a context object`);
      requireValue(
        typeof response.requestMarker === "string"
          && response.requestMarker.length > 0
          && response.responseMarker === response.requestMarker,
        `T006 response ${index} mixed request markers`,
      );
      markers.push(response.requestMarker);
    }
    requireValue(new Set(markers).size === markers.length, "T006 request markers are not unique");
    requireValue(
      Array.isArray(data.completionOrder)
        && data.completionOrder.length === markers.length
        && new Set(data.completionOrder).size === markers.length
        && data.completionOrder.every((marker) => markers.includes(marker)),
      "T006 completion order is not a permutation of the requests",
    );
    requireValue(
      Array.isArray(data.moduleCounterSamples)
        && data.moduleCounterSamples.length === markers.length
        && data.moduleCounterSamples.every(Number.isSafeInteger),
      "T006 module counter observations are malformed",
    );
    requireValue(data.orderingAssertionApplied === false, "T006 must not impose request ordering");
  },
  "EC-WEB-T007"(data) {
    exactKeys(data, ["bodyTerminalState", "chunks", "handlerSettledBeforeBodyEnd"], "T007 data");
    requireValue(data.handlerSettledBeforeBodyEnd === true, "T007 did not exercise post-settlement streaming");
    requireValue(
      JSON.stringify(data.chunks) === JSON.stringify(["stream-one", "stream-two", "stream-three"]),
      "T007 stream chunks differ or were truncated",
    );
    requireValue(data.bodyTerminalState === "closed", "T007 response body did not close normally");
  },
  "EC-WEB-T008"(data) {
    exactKeys(
      data,
      ["backgroundFailureCodes", "body", "handlerInvocationCount", "status", "taskEvidence"],
      "T008 data",
    );
    requireValue(data.status === 200 && data.body === "background-response", "T008 background failure changed the response");
    requireValue(
      JSON.stringify(data.taskEvidence) === JSON.stringify(["background-first", "background-third"]),
      "T008 successful background tasks did not settle independently",
    );
    requireValue(
      JSON.stringify(data.backgroundFailureCodes) === JSON.stringify(["EC_BACKGROUND_REJECTED"]),
      "T008 rejected task evidence differs",
    );
    requireValue(data.handlerInvocationCount === 1, "T008 background rejection retried the handler");
  },
  "EC-WEB-T009"(data) {
    exactKeys(data, ["exceptionType", "failureCode", "registeredBackgroundTaskCount"], "T009 data");
    requireValue(data.exceptionType === "TypeError", "T009 closed waitUntil did not throw TypeError synchronously");
    requireValue(data.failureCode === "EC_WAIT_UNTIL_CLOSED", "T009 failure code differs");
    requireValue(data.registeredBackgroundTaskCount === 0, "T009 registered a task after lifecycle close");
  },
  "EC-WEB-T010"(data) {
    exactKeys(
      data,
      [
        "backgroundOutcome",
        "bodyTerminalState",
        "disconnectedInvocationCount",
        "probeInheritedCancellation",
        "probeLeakedPriorMarker",
        "probeResponseMarker",
        "transactionRollbackClaimed",
      ],
      "T010 data",
    );
    requireValue(data.disconnectedInvocationCount === 1, "T010 disconnected invocation was rerun");
    requireValue(
      ["cancelled", "closed", "errored"].includes(data.bodyTerminalState),
      "T010 body terminal state is invalid",
    );
    requireValue(
      ["completed", "cancelled", "pending-at-observation"].includes(data.backgroundOutcome),
      "T010 background outcome is invalid",
    );
    requireValue(data.transactionRollbackClaimed === false, "T010 treated disconnect as a transaction rollback");
    requireValue(data.probeResponseMarker === "probe:probe-two", "T010 probe response differs");
    requireValue(data.probeLeakedPriorMarker === false, "T010 probe leaked the prior request marker");
    requireValue(data.probeInheritedCancellation === false, "T010 probe inherited prior cancellation state");
  },
  "EC-WEB-T011"(data, document) {
    exactKeys(
      data,
      [
        "canonicalArtifactSha256",
        "derivedArtifactSha256",
        "oracleSha256",
        "pinnedStandardVersion",
        "semanticWaivers",
      ],
      "T011 data",
    );
    requireValue(data.canonicalArtifactSha256 === document.artifactSha256, "T011 canonical artifact lineage differs");
    requireValue(SHA256.test(data.derivedArtifactSha256), "T011 derived artifact digest is invalid");
    requireValue(SHA256.test(data.oracleSha256), "T011 oracle digest is invalid");
    requireValue(data.pinnedStandardVersion === document.backend.standardVersion, "T011 standard version is not the deployed pin");
    requireValue(Array.isArray(data.semanticWaivers) && data.semanticWaivers.length === 0, "T011 backend applied a semantic waiver");
  },
  "EC-WEB-T012"(data) {
    exactKeys(
      data,
      [
        "calibratedWorkSha256",
        "calibratedCpuMilliseconds",
        "freshExecutionEnvironment",
        "iterations",
        "measuredCpuMilliseconds",
        "measurementKind",
        "resourceFailureCode",
        "terminalState",
        "workCompletionSentinel",
      ],
      "T012 data",
    );
    requireValue(SHA256.test(data.calibratedWorkSha256), "T012 calibrated work digest is invalid");
    requireValue(
      Number.isFinite(data.calibratedCpuMilliseconds)
        && data.calibratedCpuMilliseconds >= 8
        && data.calibratedCpuMilliseconds <= 10,
      "T012 local process-CPU calibration is not close to the 10 ms boundary",
    );
    requireValue(Number.isSafeInteger(data.iterations) && data.iterations > 0, "T012 iteration count is invalid");
    requireValue(data.freshExecutionEnvironment === true, "T012 did not use a fresh execution environment");
    requireValue(data.measurementKind === "backend-cpu", "T012 used wall time instead of backend CPU evidence");
    requireValue(
      Number.isFinite(data.measuredCpuMilliseconds)
        && data.measuredCpuMilliseconds >= 0
        && data.measuredCpuMilliseconds <= 10,
      "T012 measured workload is outside the 10 ms boundary",
    );
    requireValue(data.terminalState === "completed", "T012 workload did not complete");
    requireValue(data.workCompletionSentinel === "cpu-work-complete", "T012 completion sentinel differs");
    requireValue(data.resourceFailureCode === null, "T012 failed within the guaranteed CPU budget");
  },
  "EC-WEB-T013"(data) {
    exactKeys(
      data,
      ["completionSentinel", "failureCodes", "fetchCallCount", "originRequestCount", "redirectHopCount", "subrequestStartCount"],
      "T013 data",
    );
    requireValue(data.fetchCallCount === 49, "T013 must issue 49 fetch API calls");
    requireValue(data.redirectHopCount === 1, "T013 did not exercise one redirect hop");
    requireValue(data.subrequestStartCount === 50, "T013 did not start exactly 50 counted subrequests");
    requireValue(data.originRequestCount === 50, "T013 controlled origin request count differs");
    requireValue(Array.isArray(data.failureCodes) && data.failureCodes.length === 0, "T013 hit a failure within the guaranteed budget");
    requireValue(data.completionSentinel === "fifty-subrequests-complete", "T013 completion sentinel differs");
  },
  "EC-WEB-T014"(data) {
    exactKeys(
      data,
      [
        "connectionsWaitingBeforeBarrier",
        "firstSixCancelled",
        "firstSixResponseMarkers",
        "seventhProbeOutcome",
      ],
      "T014 data",
    );
    requireValue(
      Number.isSafeInteger(data.connectionsWaitingBeforeBarrier)
        && data.connectionsWaitingBeforeBarrier >= 6,
      "T014 did not observe six connections waiting for response headers",
    );
    requireValue(data.firstSixCancelled === false, "T014 seventh request cancelled or preempted a guaranteed connection");
    requireValue(
      JSON.stringify(data.firstSixResponseMarkers) === JSON.stringify([
        "connection-0",
        "connection-1",
        "connection-2",
        "connection-3",
        "connection-4",
        "connection-5",
      ]),
      "T014 first six responses were lost or rewritten",
    );
    requireValue(
      ["started-before-barrier", "queued-until-release"].includes(data.seventhProbeOutcome),
      "T014 seventh request outcome is invalid",
    );
  },
};

export function verifyDocument(document) {
  exactKeys(document, ["schemaVersion", "standardId", "suiteId", "backend", "artifactSha256", "cases"], "observation document");
  requireValue(document.schemaVersion === 1, "observation schemaVersion must be 1");
  requireValue(document.standardId === "edge-canon.next", "observation standardId differs");
  requireValue(document.suiteId === "EC-WEB", "observation suiteId differs");
  requireValue(SHA256.test(document.artifactSha256), "artifactSha256 is not canonical");
  exactKeys(document.backend, ["id", "implementationVersion", "standardVersion"], "backend");
  requireValue(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(document.backend.id), "backend id is invalid");
  requireValue(
    typeof document.backend.implementationVersion === "string"
      && document.backend.implementationVersion.length > 0
      && document.backend.implementationVersion.length <= 256,
    "backend implementationVersion is invalid",
  );
  requireValue(EXACT_STANDARD_VERSION.test(document.backend.standardVersion), "backend did not run an exact standard commit");
  requireValue(Array.isArray(document.cases), "cases must be an array");
  const byId = new Map();
  for (const record of document.cases) {
    exactKeys(record, ["id", "observedAt", "data", "evidenceRefs"], "case record");
    requireValue(!byId.has(record.id), `duplicate case ${record.id}`);
    requireValue(Number.isFinite(Date.parse(record.observedAt)), `${record.id} observedAt is invalid`);
    requireValue(Array.isArray(record.evidenceRefs), `${record.id} evidenceRefs must be an array`);
    requireValue(record.data && typeof record.data === "object" && !Array.isArray(record.data), `${record.id} data must be an object`);
    requireValue(
      record.evidenceRefs.every((value) => typeof value === "string" && value.length > 0 && value.length <= 2048)
        && new Set(record.evidenceRefs).size === record.evidenceRefs.length,
      `${record.id} evidenceRefs are invalid`,
    );
    byId.set(record.id, record);
  }
  requireValue(
    byId.size === EXPECTED_CASES.length && EXPECTED_CASES.every((id) => byId.has(id)),
    `draft harness requires exactly ${EXPECTED_CASES.join(", ")}`,
  );
  for (const id of EXPECTED_CASES) VERIFIERS[id](byId.get(id).data, document);
  return { suiteId: "EC-WEB", status: "pass", caseIds: [...EXPECTED_CASES] };
}

function main(path) {
  requireValue(path, "usage: node oracle.mjs OBSERVATIONS.json");
  const document = JSON.parse(fs.readFileSync(path, "utf8"));
  process.stdout.write(`${JSON.stringify(verifyDocument(document), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv[2]);
  } catch (error) {
    process.stderr.write(`EC-WEB oracle failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
