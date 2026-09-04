import fs from "node:fs";
import { pathToFileURL } from "node:url";

const EXPECTED_CASES = [
  "EC-WEB-T001",
  "EC-WEB-T002",
  "EC-WEB-T003",
  "EC-WEB-T004",
  "EC-WEB-T005",
];
const ERROR_BODY = "Internal Server Error\n";

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
};

export function verifyDocument(document) {
  exactKeys(document, ["schemaVersion", "standardId", "suiteId", "backend", "artifactSha256", "cases"], "observation document");
  requireValue(document.schemaVersion === 1, "observation schemaVersion must be 1");
  requireValue(document.standardId === "edge-canon.next", "observation standardId differs");
  requireValue(document.suiteId === "EC-WEB", "observation suiteId differs");
  requireValue(/^[0-9a-f]{64}$/.test(document.artifactSha256), "artifactSha256 is not canonical");
  exactKeys(document.backend, ["id", "implementationVersion", "standardVersion"], "backend");
  requireValue(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(document.backend.id), "backend id is invalid");
  requireValue(
    typeof document.backend.implementationVersion === "string"
      && document.backend.implementationVersion.length > 0
      && document.backend.implementationVersion.length <= 256,
    "backend implementationVersion is invalid",
  );
  requireValue(document.backend.standardVersion === "edge-canon.next", "backend did not run the exact standard version");
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
  for (const id of EXPECTED_CASES) VERIFIERS[id](byId.get(id).data);
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
