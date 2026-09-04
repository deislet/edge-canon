import fs from "node:fs";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_STANDARD = /^edge-canon\.next@[0-9a-f]{40}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXPECTED_CASES = Array.from({ length: 14 }, (_, index) => `EC-WEBAPI-T${String(index + 1).padStart(3, "0")}`);

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

function settlement(value, expected, name, label) {
  exactKeys(value, expected === "throw" ? ["settlement", "name"] : ["settlement", "name", "isResponse"], label);
  requireValue(value.settlement === expected && value.name === name, `${label} settlement differs`);
  if ("isResponse" in value) requireValue(value.isResponse === false, `${label} synthesized a Response`);
}

const VERIFIERS = {
  "EC-WEBAPI-T001"(data) {
    exactKeys(data, ["urls", "expectedUrls", "beforeSort", "afterSort", "serializedQuery"], "T001 data");
    requireValue(equal(data.urls, data.expectedUrls) && equal(data.urls, [
      "https://example.com/a//c?q=hello%20world&q=%2F#frag",
      "https://example.com/a/d%20e?x=%E2%9C%93",
    ]), "T001 URL serialization differs");
    requireValue(equal(data.beforeSort, [["z", "last"], ["a", "first"], ["a", "second"], ["a", "third value"]]), "T001 query insertion order differs");
    requireValue(equal(data.afterSort, [["a", "first"], ["a", "second"], ["a", "third value"], ["z", "last"]]), "T001 query sort was not stable");
    requireValue(data.serializedQuery === "a=first&a=second&a=third+value&z=last", "T001 query serialization differs");
  },
  "EC-WEBAPI-T002"(data) {
    exactKeys(data, ["entries", "getCombined", "forEach", "invalidHeaders"], "T002 data");
    const expected = [["x-a", "first, second"], ["x-m", "middle"], ["x-z", "one"]];
    requireValue(equal(data.entries, expected) && equal(data.forEach, expected) && data.getCombined === "first, second", "T002 header normalization, merge, sort, or forEach differs");
    requireValue(equal(data.invalidHeaders.map((value) => value.variant), ["space-name", "nul-value", "crlf-value"]), "T002 invalid header vectors differ");
    for (const value of data.invalidHeaders) settlement({ settlement: value.settlement, name: value.name }, "throw", "TypeError", `T002 ${value.variant}`);
  },
  "EC-WEBAPI-T003"(data) {
    exactKeys(data, ["properties", "originalHeaders", "cloneHeaders", "bodies", "headerObjectsDistinct", "getBodyError"], "T003 data");
    exactKeys(data.properties, ["url", "method", "redirect", "signalInitiallyAborted", "signalFollowsAbort", "cloneSignalFollowsAbort"], "T003 properties");
    requireValue(equal(data.properties, {
      url: "https://example.com/api?q=1", method: "POST", redirect: "manual",
      signalInitiallyAborted: false, signalFollowsAbort: true, cloneSignalFollowsAbort: true,
    }), "T003 Request properties or signal propagation differ");
    requireValue(equal(data.bodies, ["payload", "payload"]) && data.headerObjectsDistinct === true, "T003 clone body independence differs");
    requireValue(data.originalHeaders.some(([name, value]) => name === "x-original" && value === "changed"), "T003 original header mutation missing");
    requireValue(data.cloneHeaders.some(([name, value]) => name === "x-original" && value === "yes") && data.cloneHeaders.some(([name]) => name === "x-clone"), "T003 clone headers were not independent");
    settlement(data.getBodyError, "throw", "TypeError", "T003 GET body");
  },
  "EC-WEBAPI-T004"(data) {
    exactKeys(data, ["normal", "redirects", "errorResponse", "invalidConstructor", "invalidRedirect"], "T004 data");
    requireValue(equal(data.normal, { status: 201, statusText: "Created", ok: true, redirected: false, url: "", header: "yes", body: "created" }), "T004 normal response differs");
    requireValue(equal(data.redirects, [301, 302, 303, 307, 308].map((status) => ({ status, location: "https://example.com/next" }))), "T004 redirect responses differ");
    requireValue(data.errorResponse.status === 0 && data.errorResponse.ok === false && data.errorResponse.body === null, "T004 error response differs");
    settlement(data.invalidConstructor, "throw", "RangeError", "T004 invalid constructor status");
    settlement(data.invalidRedirect, "throw", "RangeError", "T004 invalid redirect status");
  },
  "EC-WEBAPI-T005"(data) {
    exactKeys(data, ["textValue", "bodyUsed", "secondRead", "cloneBodies", "readers", "requestReaders", "invalidJson"], "T005 data");
    requireValue(data.textValue === "hello" && data.bodyUsed === true, "T005 initial read differs");
    settlement(data.secondRead, "reject", "TypeError", "T005 second read");
    requireValue(equal(data.cloneBodies, ["clone-body", "clone-body"]), "T005 clone branches differ");
    requireValue(equal(data.readers, {
      arrayBufferLength: 3, blobText: "blob", jsonValue: { value: 7 }, formEntries: [["a", "1"], ["a", "2"]],
    }), "T005 body readers differ");
    requireValue(equal(data.requestReaders, {
      text: "request-text", arrayBufferLength: 3, blobText: "request-blob",
      jsonValue: { request: 8 }, formEntries: [["r", "1"], ["r", "2"]],
    }), "T005 Request body readers differ");
    settlement(data.invalidJson, "reject", "SyntaxError", "T005 invalid JSON");
  },
  "EC-WEBAPI-T006"(data) {
    exactKeys(data, ["encoding", "decoderProperties", "encoded", "encodeInto", "encodeIntoBytes", "decoded", "streamParts", "replacement", "fatalError", "base64", "invalidBase64", "unicodeBtoa"], "T006 data");
    requireValue(data.encoding === "utf-8" && equal(data.encoded, [65, 226, 156, 147, 240, 144, 141, 136]) && data.decoded === "A✓𐍈", "T006 UTF-8 encoding differs");
    requireValue(equal(data.decoderProperties, { encoding: "utf-8", fatal: true, ignoreBOM: true }), "T006 TextDecoder properties differ");
    requireValue(equal(data.encodeInto, { read: 2, written: 4 }) && equal(data.encodeIntoBytes, [226, 156, 147, 120]), "T006 encodeInto differs");
    requireValue(equal(data.streamParts, ["", "✓"]) && data.replacement === "�(", "T006 decoder streaming or replacement differs");
    settlement(data.fatalError, "throw", "TypeError", "T006 fatal decode");
    requireValue(equal(data.base64, { encoded: "AP9B", decodedCodes: [0, 255, 65] }), "T006 base64 binary-string behavior differs");
    settlement(data.invalidBase64, "throw", "InvalidCharacterError", "T006 invalid base64");
    settlement(data.unicodeBtoa, "throw", "InvalidCharacterError", "T006 Unicode btoa");
  },
  "EC-WEBAPI-T007"(data) {
    exactKeys(data, ["initialAborted", "finalAborted", "abortEvents", "abortResult", "independent", "completedAfterLateAbort"], "T007 data");
    requireValue(data.initialAborted === false && data.finalAborted === true && data.abortEvents === 1, "T007 signal state/event count differs");
    settlement(data.abortResult, "reject", "AbortError", "T007 abort fetch");
    requireValue(data.independent === "healthy" && data.completedAfterLateAbort === "healthy", "T007 abort leaked or rewrote a completed result");
  },
  "EC-WEBAPI-T008"(data) {
    exactKeys(data, ["sameRandomBuffer", "randomNonZero", "uuid", "digest", "expectedDigest"], "T008 data");
    requireValue(data.sameRandomBuffer === true && data.randomNonZero === true, "T008 random buffer behavior differs");
    requireValue(typeof data.uuid === "string" && UUID_V4.test(data.uuid), "T008 UUID is not RFC 4122 v4/variant");
    requireValue(data.digest === data.expectedDigest && data.digest === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "T008 SHA-256 differs");
  },
  "EC-WEBAPI-T009"(data) {
    exactKeys(data, ["manual", "redirectError", "postResult", "methodResults", "crossOrigin"], "T009 data");
    requireValue(data.manual.status === 302 && data.manual.location === "/target" && data.manual.url.endsWith("/manual"), "T009 manual redirect differs");
    settlement(data.redirectError, "reject", "TypeError", "T009 error redirect mode");
    requireValue(data.postResult.method === "GET" && data.postResult.bodyLength === 0 && data.postResult.headers["content-type"] === undefined, "T009 303 method/body header conversion differs");
    requireValue(equal(data.methodResults, [
      { status: 301, method: "GET", bodyLength: 0, contentType: null },
      { status: 302, method: "GET", bodyLength: 0, contentType: null },
      { status: 303, method: "GET", bodyLength: 0, contentType: null },
      { status: 307, method: "POST", bodyLength: 9, contentType: "text/plain" },
      { status: 308, method: "POST", bodyLength: 9, contentType: "text/plain" },
    ]), "T009 redirect method matrix differs");
    requireValue(data.crossOrigin.finalUrl === `${data.crossOrigin.expectedOrigin}/capture` && data.crossOrigin.method === "GET", "T009 cross-origin target differs");
    requireValue(data.crossOrigin.authorization === null && data.crossOrigin.cookie === null && data.crossOrigin.proxyAuthorization === null, "T009 leaked redirect credentials");
  },
  "EC-WEBAPI-T010"(data) {
    exactKeys(data, ["trace", "clearedCount", "intervalCount"], "T010 data");
    requireValue(equal(data.trace, ["sync", "timeout", "interval-1", "interval-2"]) && data.clearedCount === 0 && data.intervalCount === 2, "T010 timer ordering or cancellation differs");
  },
  "EC-WEBAPI-T011"(data) {
    exactKeys(data, ["completionOrder", "results"], "T011 data");
    requireValue(equal([...data.completionOrder].sort(), ["1", "2", "3"]) && data.completionOrder[0] !== "1", "T011 did not observe independent completion ordering");
    requireValue(equal(data.results, [
      { requestedId: "1", headerId: "1", body: "body-1" },
      { requestedId: "2", headerId: "2", body: "body-2" },
      { requestedId: "3", headerId: "3", body: "body-3" },
    ]), "T011 associated a response with another request");
  },
  "EC-WEBAPI-T012"(data) {
    exactKeys(data, ["body", "header", "random"], "T012 data");
    exactKeys(data.body, ["length", "sha256", "expectedSha256", "requestReaderCapacities", "responseReaderCapacities"], "T012 body");
    const capacities = { textLength: 1_000_000, arrayBufferLength: 1_000_000, blobSize: 1_000_000, jsonValueLength: 999_992, formValueLength: 999_998 };
    requireValue(data.body.length === 1_000_000 && SHA256.test(data.body.sha256) && data.body.sha256 === data.body.expectedSha256, "T012 body capacity differs");
    requireValue(equal(data.body.requestReaderCapacities, capacities) && equal(data.body.responseReaderCapacities, capacities), "T012 body reader capacity matrix differs");
    requireValue(equal(data.header, { nameLength: 128, valueLength: 4_095 }), "T012 header capacity differs");
    requireValue(data.random.acceptedLength === 65_536, "T012 random positive boundary differs");
    settlement(data.random.overRandom, "throw", "QuotaExceededError", "T012 random over-limit");
  },
  "EC-WEBAPI-T013"(data) {
    exactKeys(data, ["networkFailure", "parseFailure", "parseBodyUsed", "healthy"], "T013 data");
    settlement(data.networkFailure, "reject", "TypeError", "T013 network failure");
    settlement(data.parseFailure, "reject", "SyntaxError", "T013 parse failure");
    requireValue(data.parseBodyUsed === true && data.healthy === "healthy", "T013 failure recovery or isolation differs");
  },
  "EC-WEBAPI-T014"(data) {
    exactKeys(data, ["baselineDate", "mutations", "cloudflare", "requiredApiKeys", "providerExtensionKeys"], "T014 data");
    requireValue(data.baselineDate === "2026-09-04", "T014 upstream baseline differs");
    const expectedCodes = new Map([
      ["higher-major", "EC_WEBAPI_VERSION_UNSUPPORTED"], ["floating-standard", "EC_WEBAPI_STANDARD_PIN_INVALID"],
      ["unknown-field", "EC_WEBAPI_DOCUMENT_INVALID"], ["provider-extension-required", "EC_WEBAPI_EXTENSION_POLICY_INVALID"],
    ]);
    requireValue(data.mutations.length === expectedCodes.size && data.mutations.every((value) => value.code === expectedCodes.get(value.variant) && value.applicationExecutions === 0), "T014 accepted an invalid lock or executed application code");
    requireValue(equal(data.cloudflare, {
      providerId: "cloudflare-workers-pages", urlParser: "standard", responseRedirectUrlParser: "standard",
      compatibilityDateFloor: "2023-03-14", redirectCredentials: "edge-canon-shim",
    }), "T014 Cloudflare derived configuration differs");
    requireValue(equal(data.requiredApiKeys, ["abort", "base64", "crypto", "encoding", "fetch", "headers", "request", "response", "timers", "url"]) && equal(data.providerExtensionKeys, []), "T014 provider extensions entered the required API surface");
  },
};

export function verifyDocument(document) {
  exactKeys(document, ["schemaVersion", "standardId", "suiteId", "backend", "artifactSha256", "cases"], "observation document");
  requireValue(document.schemaVersion === 1 && document.standardId === "edge-canon.next" && document.suiteId === "EC-WEBAPI", "observation identity differs");
  requireValue(SHA256.test(document.artifactSha256), "capability lock digest is invalid");
  exactKeys(document.backend, ["id", "implementationVersion", "standardVersion"], "backend");
  requireValue(document.backend.id === "edge-canon-reference-webapi" && document.backend.implementationVersion === "edge-canon-reference-webapi-harness/1", "reference backend identity differs");
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
  requireValue(byId.size === EXPECTED_CASES.length && EXPECTED_CASES.every((id) => byId.has(id)), "draft harness requires exactly fourteen Web API cases");
  for (const id of EXPECTED_CASES) VERIFIERS[id](byId.get(id).data, document);
  return { suiteId: "EC-WEBAPI", status: "pass", caseIds: [...EXPECTED_CASES] };
}

function main(file) {
  requireValue(file, "usage: node oracle.mjs OBSERVATIONS.json");
  process.stdout.write(`${JSON.stringify(verifyDocument(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv[2]); }
  catch (error) {
    process.stderr.write(`EC-WEBAPI oracle failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
