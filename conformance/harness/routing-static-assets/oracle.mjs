import fs from "node:fs";
import { pathToFileURL } from "node:url";

const EXPECTED_CASES = Array.from({ length: 11 }, (_, index) => `EC-ROUTING-T${String(index + 1).padStart(3, "0")}`);
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

function outcomeKeys(value, label) {
  exactKeys(value, ["kind", "status", "location", "entrypointId", "headerRuleId", "bodySha256", "representationSha256", "routedPathname", "routedQuery", "trace"], label);
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const VERIFIERS = {
  "EC-ROUTING-T001"(data) {
    exactKeys(data, ["redirect", "rewritten", "assetFunctionCollision", "fallback"], "T001 data");
    for (const [key, value] of Object.entries(data)) outcomeKeys(value, `T001 ${key}`);
    requireValue(data.redirect.kind === "redirect" && equal(data.redirect.trace, ["redirect:old-first"]), "T001 redirect did not terminate first");
    requireValue(data.rewritten.kind === "function" && data.rewritten.entrypointId === "api-handler" && equal(data.rewritten.trace, ["rewrite:legacy-api", "function:api-function"]), "T001 rewrite pipeline differs");
    requireValue(data.assetFunctionCollision.kind === "asset" && equal(data.assetFunctionCollision.trace, ["asset"]), "T001 asset did not win the function collision");
    requireValue(data.fallback.kind === "not-found" && equal(data.fallback.trace, ["fallback:not-found"]), "T001 fallback pipeline differs");
  },
  "EC-ROUTING-T002"(data) {
    exactKeys(data, ["parameter", "multiSegmentKind", "splat", "queryExcludedFromMatch", "wrongCaseKind"], "T002 data");
    exactKeys(data.parameter, ["location", "params"], "T002 parameter");
    exactKeys(data.splat, ["first", "second", "entrypointIds"], "T002 splat");
    requireValue(data.parameter.location === "/new/Value?x=1" && data.parameter.params.id === "Value", "T002 parameter expansion differs");
    requireValue(data.multiSegmentKind === "not-found", "T002 single-segment parameter crossed a slash");
    requireValue(equal(data.splat.first, { splat: ["One", "two"] }) && equal(data.splat.first, data.splat.second), "T002 splat capture differs");
    requireValue(equal(data.splat.entrypointIds, ["files-handler", "files-handler"]) && data.queryExcludedFromMatch === true, "T002 query changed route matching");
    requireValue(data.wrongCaseKind === "not-found", "T002 matching was not case-sensitive");
  },
  "EC-ROUTING-T003"(data) {
    exactKeys(data, ["get", "head", "emptySha256"], "T003 data");
    const responseKeys = ["status", "headers", "bodySha256", "representationSha256", "bodySize"];
    exactKeys(data.get, responseKeys, "T003 GET");
    exactKeys(data.head, responseKeys, "T003 HEAD");
    requireValue(SHA256.test(data.get.bodySha256) && data.get.bodySha256 === data.get.representationSha256, "T003 GET bytes differ from the representation");
    requireValue(data.get.status === 200 && data.head.status === 200 && equal(data.get.headers, data.head.headers), "T003 HEAD headers differ from GET");
    requireValue(data.head.bodySha256 === data.emptySha256 && data.head.bodySize === 0 && data.head.representationSha256 === data.get.representationSha256, "T003 HEAD returned body bytes or another representation");
    requireValue(data.get.bodySize > 0 && SHA256.test(data.emptySha256), "T003 body sizes or digest are invalid");
  },
  "EC-ROUTING-T004"(data) {
    exactKeys(data, ["internal", "external", "laterStageCount"], "T004 data");
    outcomeKeys(data.internal, "T004 internal");
    outcomeKeys(data.external, "T004 external");
    requireValue(data.internal.status === 301 && data.internal.location === "/new/9?keep=yes", "T004 internal redirect differs");
    requireValue(data.external.status === 302 && data.external.location === "https://docs.example.test/guide", "T004 external redirect or discard policy differs");
    requireValue(data.internal.trace.length === 1 && data.external.trace.length === 1 && data.laterStageCount === 0, "T004 redirect continued into a later stage");
  },
  "EC-ROUTING-T005"(data) {
    exactKeys(data, ["rewritten", "method", "requestBodySha256", "expectedBodySha256", "rewriteCount", "unmatched", "originHitCount"], "T005 data");
    outcomeKeys(data.rewritten, "T005 rewritten");
    outcomeKeys(data.unmatched, "T005 unmatched");
    requireValue(data.rewritten.kind === "function" && data.rewritten.entrypointId === "api-handler" && data.rewritten.routedPathname === "/api/42", "T005 rewrite target differs");
    requireValue(equal(data.rewritten.trace, ["rewrite:legacy-api", "function:api-function"]) && data.rewriteCount === 1, "T005 rewrite chained or ran more than once");
    requireValue(data.method === "POST" && data.requestBodySha256 === data.expectedBodySha256 && data.rewritten.routedQuery === "keep=yes", "T005 changed method, body, or query");
    requireValue(data.unmatched.kind === "not-found" && data.originHitCount === 0, "T005 unmatched rewrite path escaped explicit fallback");
  },
  "EC-ROUTING-T006"(data) {
    exactKeys(data, ["selectedHeaderRule", "staticHeaders", "functionHeaders", "mutations"], "T006 data");
    requireValue(data.selectedHeaderRule === "all-static", "T006 did not select the first header rule");
    requireValue(data.staticHeaders.some((value) => value.name === "X-Route" && value.value === "first") && !data.staticHeaders.some((value) => value.value === "second"), "T006 merged a later header rule");
    requireValue(equal(data.functionHeaders, []), "T006 applied static headers to a function response");
    const expected = new Map([["crlf", "EC_ROUTING_HEADER_INVALID"], ["set-cookie", "EC_ROUTING_HEADER_INVALID"], ["dynamic-authority", "EC_ROUTING_DESTINATION_INVALID"]]);
    requireValue(data.mutations.length === expected.size && data.mutations.every((value) => value.code === expected.get(value.variant)), "T006 accepted a header or redirect injection mutation");
  },
  "EC-ROUTING-T007"(data) {
    exactKeys(data, ["fallbacks", "originHitCount"], "T007 data");
    requireValue(data.fallbacks.length === 3, "T007 fallback set is incomplete");
    const expected = new Map([["not-found", 404], ["custom-404", 404], ["spa", 200]]);
    for (const value of data.fallbacks) {
      exactKeys(value, ["kind", "first", "headerVariantSame"], `T007 ${value.kind}`);
      outcomeKeys(value.first, `T007 ${value.kind} outcome`);
      requireValue(value.first.status === expected.get(value.kind) && value.headerVariantSame === true, `T007 ${value.kind} status or request-header independence differs`);
      if (value.kind === "not-found") requireValue(value.first.kind === "not-found" && value.first.bodySha256 === value.first.representationSha256, "T007 empty 404 differs");
      else requireValue(value.first.kind === "asset" && SHA256.test(value.first.representationSha256), `T007 ${value.kind} asset differs`);
    }
    requireValue(data.originHitCount === 0, "T007 used an implicit origin");
  },
  "EC-ROUTING-T008"(data) {
    exactKeys(data, ["requests", "artifacts", "providerDerivationCount", "diagnosticsSanitized"], "T008 data");
    requireValue(data.requests.length === 7 && data.requests.every((value) => SHA256.test(value.variantSha256) && value.status === 400 && value.code === "EC_ROUTING_PATH_INVALID" && value.terminal === null), "T008 accepted an unsafe request path");
    const expected = new Map([
      ["traversal", "EC_ROUTING_ASSET_PATH_INVALID"], ["link", "EC_ROUTING_ASSET_INVALID"],
      ["missing", "EC_ROUTING_ASSET_INVALID"], ["digest", "EC_ROUTING_ASSET_INVALID"], ["unlisted", "EC_ROUTING_ASSET_INVALID"],
    ]);
    requireValue(data.artifacts.length === expected.size && data.artifacts.every((value) => value.code === expected.get(value.variant)), "T008 accepted an unsafe or corrupted asset collection");
    requireValue(data.providerDerivationCount === 0 && data.diagnosticsSanitized === true, "T008 derived provider output or leaked diagnostic data");
  },
  "EC-ROUTING-T009"(data) {
    exactKeys(data, ["oldIdentity", "newIdentity", "requestCount", "observedPairs", "expectedPairs", "mixedPairCount", "mixedSnapshotValidationCodes"], "T009 data");
    requireValue(SHA256.test(data.oldIdentity) && SHA256.test(data.newIdentity) && data.oldIdentity !== data.newIdentity, "T009 old and new identities are invalid");
    requireValue(data.requestCount === 64 && equal(data.observedPairs, data.expectedPairs) && data.expectedPairs.length === 2 && data.mixedPairCount === 0, "T009 observed a non-deterministic or mixed snapshot");
    requireValue(equal(data.mixedSnapshotValidationCodes, ["EC_ROUTING_ASSET_INVALID", "EC_ROUTING_ASSET_INVALID"]), "T009 accepted mixed route and asset snapshots");
  },
  "EC-ROUTING-T010"(data) {
    exactKeys(data, ["acceptedCounts", "maximumSourceLength", "maximumDestinationLengths", "maximumHeaderLengths", "lastRedirect", "lastRewrite", "lastHeader", "overLimitCode"], "T010 data");
    exactKeys(data.acceptedCounts, ["transforms", "headerRules", "headersPerRule"], "T010 counts");
    outcomeKeys(data.lastRedirect, "T010 redirect");
    outcomeKeys(data.lastRewrite, "T010 rewrite");
    exactKeys(data.lastHeader, ["outcome", "valueCount"], "T010 header");
    outcomeKeys(data.lastHeader.outcome, "T010 header outcome");
    requireValue(equal(data.acceptedCounts, { transforms: 100, headerRules: 30, headersPerRule: 30 }) && data.maximumSourceLength === 500, "T010 minimum capacity boundary was not accepted");
    requireValue(equal(data.maximumDestinationLengths, [500, 500]) && equal(data.maximumHeaderLengths, [100, 1000]), "T010 maximum field lengths were not accepted");
    requireValue(equal(data.lastRedirect.trace, ["redirect:redirect-49"]), "T010 last redirect rule did not match");
    requireValue(equal(data.lastRewrite.trace, ["rewrite:rewrite-49", "fallback:spa"]) && data.lastRewrite.routedPathname.length === 500, "T010 last rewrite rule did not match");
    requireValue(data.lastHeader.outcome.headerRuleId === "headers-29" && data.lastHeader.valueCount === 30, "T010 last header rule did not apply all values");
    requireValue(data.overLimitCode === "EC_ROUTING_HEADER_INVALID", "T010 accepted a 31st header value");
  },
  "EC-ROUTING-T011"(data) {
    exactKeys(data, ["versions", "sourceIdentity", "migratedIdentity", "sourceMutated", "outcomeDiff"], "T011 data");
    const expected = new Map([
      ["higher-major", "EC_ROUTING_VERSION_UNSUPPORTED"],
      ["floating-standard", "EC_ROUTING_STANDARD_PIN_INVALID"],
      ["unknown-field", "EC_ROUTING_DOCUMENT_INVALID"],
      ["nested-unknown-field", "EC_ROUTING_DOCUMENT_INVALID"],
    ]);
    requireValue(data.versions.length === expected.size && data.versions.every((value) => value.code === expected.get(value.variant) && value.expected === value.code && value.assetReadsBeforeRejection === 0), "T011 version rejection was late or returned another code");
    requireValue(SHA256.test(data.sourceIdentity) && SHA256.test(data.migratedIdentity) && data.sourceIdentity !== data.migratedIdentity && data.sourceMutated === false, "T011 migration reused identity or mutated its input");
    requireValue(equal(data.outcomeDiff, { routeId: "old-first", beforeStatus: 301, afterStatus: 302 }), "T011 did not record the intentional behavior difference");
  },
};

export function verifyDocument(document) {
  exactKeys(document, ["schemaVersion", "standardId", "suiteId", "backend", "artifactSha256", "cases"], "observation document");
  requireValue(document.schemaVersion === 1 && document.standardId === "edge-canon.next" && document.suiteId === "EC-ROUTING", "observation identity differs");
  requireValue(SHA256.test(document.artifactSha256), "routing artifact digest is invalid");
  exactKeys(document.backend, ["id", "implementationVersion", "standardVersion"], "backend");
  requireValue(document.backend.id === "edge-canon-reference-router" && document.backend.implementationVersion === "edge-canon-reference-routing-harness/1", "reference backend identity differs");
  requireValue(EXACT_STANDARD_VERSION.test(document.backend.standardVersion), "backend did not run an exact standard commit");
  requireValue(Array.isArray(document.cases), "cases must be an array");
  const byId = new Map();
  for (const item of document.cases) {
    exactKeys(item, ["id", "observedAt", "data", "evidenceRefs"], "case record");
    requireValue(!byId.has(item.id), `duplicate case ${item.id}`);
    requireValue(Number.isFinite(Date.parse(item.observedAt)), `${item.id} observedAt is invalid`);
    requireValue(Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0 && new Set(item.evidenceRefs).size === item.evidenceRefs.length, `${item.id} evidence references are invalid`);
    byId.set(item.id, item);
  }
  requireValue(byId.size === EXPECTED_CASES.length && EXPECTED_CASES.every((id) => byId.has(id)), "draft harness requires exactly eleven routing cases");
  for (const id of EXPECTED_CASES) VERIFIERS[id](byId.get(id).data, document);
  return { suiteId: "EC-ROUTING", status: "pass", caseIds: [...EXPECTED_CASES] };
}

function main(file) {
  requireValue(file, "usage: node oracle.mjs OBSERVATIONS.json");
  process.stdout.write(`${JSON.stringify(verifyDocument(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv[2]);
  } catch (error) {
    process.stderr.write(`EC-ROUTING oracle failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
