import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_MODULES, FIXTURE_INSTALLED_OCTETS, FIXTURE_PACKAGES, NODE_BASELINE_VERSION } from "./fixture.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_STANDARD = /^edge-canon\.next@[0-9a-f]{40}$/;
const EXPECTED_CASES = Array.from({ length: 15 }, (_, index) => `EC-NODE-T${String(index + 1).padStart(3, "0")}`);

function fail(message) { throw new Error(message); }
function requireValue(condition, message) { if (!condition) fail(message); }
function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function exactKeys(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  requireValue(equal(Object.keys(value).sort(), [...keys].sort()), `${label} fields differ`);
}

const VERIFIERS = {
  "EC-NODE-T001"(data) {
    exactKeys(data, ["runtime", "inventory", "bareCanonical", "unsupportedBuiltin", "unsupportedExport"], "T001 data");
    requireValue(data.runtime === NODE_BASELINE_VERSION, "T001 did not run Node 24.20.0");
    requireValue(data.inventory.length === Object.keys(BUILTIN_MODULES).length, "T001 module inventory count differs");
    for (const item of data.inventory) {
      exactKeys(item, ["specifier", "exports", "present", "missing"], "T001 inventory item");
      requireValue(equal(item.exports, BUILTIN_MODULES[item.specifier]) && equal(item.present, item.exports) && equal(item.missing, []), `T001 missing or extra selected export in ${item.specifier}`);
    }
    requireValue(data.bareCanonical === "node:path" && data.unsupportedBuiltin === "EC_NODE_BUILTIN_UNSUPPORTED" && data.unsupportedExport === "EC_NODE_EXPORT_UNSUPPORTED", "T001 source policy differs");
  },
  "EC-NODE-T002"(data) {
    exactKeys(data, ["utf8", "hex", "viewAliases", "assertionError"], "T002 data");
    requireValue(data.utf8 === "edge-Canon" && data.hex === "656467652d43616e6f6e" && data.viewAliases === true, "T002 Buffer semantics differ");
    requireValue(equal(data.assertionError, { name: "AssertionError", code: "ERR_ASSERTION", actual: 1, expected: 2, operator: "deepStrictEqual" }), "T002 AssertionError semantics differ");
  },
  "EC-NODE-T003"(data) {
    exactKeys(data, ["digest", "hmac", "equalTiming", "unequalTiming", "compression"], "T003 data");
    requireValue(data.digest === "cfa7d671d5f577ea4f8847ef508612bd3af792071334dcf00ffb1dfe57d2489c" && data.hmac === "511dc83d6a37511e6a7da6a06e644dd1cfcf9392da2100b137d73fc0f114405b", "T003 crypto output differs");
    requireValue(data.equalTiming === true && data.unequalTiming === false, "T003 timingSafeEqual differs");
    for (const name of ["gzip", "deflate", "brotli"]) requireValue(data.compression[name].compressedOctets > 0 && data.compression[name].roundtrip === "edge-canon-node-24", `T003 ${name} roundtrip differs`);
  },
  "EC-NODE-T004"(data) {
    exactKeys(data, ["eventTrace", "onceValue", "diagnosticTrace", "hasSubscribersAfter"], "T004 data");
    requireValue(equal(data.eventTrace, ["first-7", "second-7"]) && equal(data.onceValue, ["only"]), "T004 EventEmitter order differs");
    requireValue(data.diagnosticTrace.length === 1 && data.diagnosticTrace[0].message.value === 1 && data.hasSubscribersAfter === false, "T004 diagnostics subscription lifecycle differs");
  },
  "EC-NODE-T005"(data) {
    exactKeys(data, ["pathValues", "urlValues", "queryValues", "utilValues"], "T005 data");
    requireValue(equal(data.pathValues, { posix: "/a/c", win32: "C:\\a\\c", relative: "../c/d", parsed: { root: "/", dir: "/srv/app", base: "index.mjs", ext: ".mjs", name: "index" } }), "T005 path output differs");
    requireValue(equal(data.urlValues, { ascii: "xn--r8jz45g.xn--zckzah", unicode: "例え.テスト", params: ["1", "2"] }), "T005 URL output differs");
    requireValue(equal(data.queryValues, { stringified: "a=x%20y&b=1&b=2", parsed: { a: "x y", b: ["1", "2"] } }), "T005 querystring output differs");
    requireValue(equal(data.utilValues, { formatted: "value:7:{\"ok\":true}", stripped: "red", inspected: "{ a: 1, b: 2 }" }), "T005 util output differs");
  },
  "EC-NODE-T006"(data) {
    exactKeys(data, ["decoded", "streamed", "streamTrace", "streamError"], "T006 data");
    requireValue(data.decoded === "A😀B" && equal(data.streamed, ["EDGE", "CANON"]), "T006 decoder or stream bytes differ");
    requireValue(equal(data.streamTrace, ["transform-edge", "write-EDGE", "transform-canon", "write-CANON"]), "T006 pipeline order differs");
    requireValue(equal(data.streamError, { settlement: "reject", name: "Error", code: "E_STREAM_FIXTURE" }), "T006 stream error was changed or hidden");
  },
  "EC-NODE-T007"(data) {
    exactKeys(data, ["scheduleOrder", "contexts", "exitLifecycle", "storeAfterRun"], "T007 data");
    requireValue(equal(data.scheduleOrder, ["callback", "nextTick", "promise", "immediate"]), "T007 scheduling order differs");
    requireValue(equal(data.contexts.A, ["A", "A", "A", "A", "A"]) && equal(data.contexts.B, ["B", "B", "B", "B", "B"]), "T007 AsyncLocalStorage contexts crossed");
    requireValue(equal(data.exitLifecycle, { exited: { store: null, sum: 5 }, restored: "outer" }), "T007 AsyncLocalStorage exit semantics differ");
    requireValue(data.storeAfterRun === null, "T007 AsyncLocalStorage context escaped run");
  },
  "EC-NODE-T008"(data) {
    exactKeys(data, ["importTarget", "requireTarget", "fallbackTarget", "canonicalBuiltin", "moduleTypes"], "T008 data");
    requireValue(data.importTarget === "./edge.mjs" && data.requireTarget === "./edge.mjs" && data.fallbackTarget === "./default.mjs", "T008 conditional resolution differs");
    requireValue(data.canonicalBuiltin === "node:events" && equal(data.moduleTypes, { root: "module", esm: "module", cjs: "commonjs" }), "T008 builtin or type resolution differs");
  },
  "EC-NODE-T009"(data) {
    exactKeys(data, ["defaultValue", "staticEsm", "runtimeRequireReferences", "artifactSha256"], "T009 data");
    requireValue(equal(data.defaultValue, { value: 42 }) && data.staticEsm === true && data.runtimeRequireReferences === 0 && SHA256.test(data.artifactSha256), "T009 CommonJS-to-ESM transform differs");
  },
  "EC-NODE-T010"(data) {
    exactKeys(data, ["identities", "packageCounts", "failures"], "T010 data");
    requireValue(data.identities.length === 2 && data.identities[0] === data.identities[1] && SHA256.test(data.identities[0]) && equal(data.packageCounts, [2, 2]), "T010 deterministic graph differs");
    requireValue(equal(data.failures, { missingLock: "EC_NPM_LOCK_REQUIRED", oldLock: "EC_NPM_LOCK_VERSION_UNSUPPORTED", mismatch: "EC_NPM_LOCK_MISMATCH", missingIntegrity: "EC_NPM_INTEGRITY_REQUIRED", changedIntegrity: "EC_NPM_INTEGRITY_FAILED" }), "T010 lock/integrity failures differ");
  },
  "EC-NODE-T011"(data) {
    exactKeys(data, ["sourceFailures", "packageFailures", "applicationExecutions", "hookExecutions", "nativeHandles"], "T011 data");
    requireValue(equal(data.sourceFailures, { dynamicRequire: "EC_NPM_DYNAMIC_RESOLUTION_UNSUPPORTED", dynamicImport: "EC_NPM_DYNAMIC_RESOLUTION_UNSUPPORTED", childProcess: "EC_NODE_BUILTIN_UNSUPPORTED" }), "T011 source rejection differs");
    requireValue(equal(data.packageFailures, { installHook: "EC_NPM_LIFECYCLE_SCRIPT_UNSUPPORTED", nativeAddon: "EC_NPM_NATIVE_ADDON_UNSUPPORTED" }), "T011 package rejection differs");
    requireValue(data.applicationExecutions === 0 && data.hookExecutions === 0 && data.nativeHandles === 0, "T011 executed rejected code");
  },
  "EC-NODE-T012"(data) {
    exactKeys(data, ["version", "nodeVersion", "platform", "env", "visibleFields", "builtin"], "T012 data");
    requireValue(data.version === "v24.20.0" && data.nodeVersion === "24.20.0" && data.platform === "linux", "T012 process normalization differs");
    requireValue(data.env.A.TENANT === "A" && data.env.A.SHARED === "changed-a" && data.env.B.TENANT === "B" && data.env.B.SHARED === "initial", "T012 env snapshots crossed invocations");
    requireValue(equal(data.visibleFields, ["env", "getBuiltinModule", "nextTick", "platform", "version", "versions"]), "T012 process facade leaks or misses fields");
    exactKeys(data.builtin, ["pathJoin", "pathResolve", "posixResolve", "win32Resolve", "pathFields", "relativeFileUrl", "posixFilePath", "windowsFilePath", "urlFields", "unsupportedIsUndefined"], "T012 builtin facade");
    requireValue(data.builtin.pathJoin === "edge/canon" && data.builtin.pathResolve === "/edge/canon" && data.builtin.posixResolve === "/edge/canon" && data.builtin.win32Resolve === "\\edge\\canon", "T012 path facade depends on the host");
    requireValue(data.builtin.relativeFileUrl === "file:///asset%20%23%25.txt" && data.builtin.posixFilePath === "/asset space.txt" && data.builtin.windowsFilePath === "C:\\asset space.txt", "T012 URL file conversion depends on the host");
    requireValue(equal(data.builtin.pathFields, BUILTIN_MODULES["node:path"].slice().sort()) && equal(data.builtin.urlFields, BUILTIN_MODULES["node:url"].slice().sort()) && data.builtin.unsupportedIsUndefined === true, "T012 getBuiltinModule does not return the selected module facade");
  },
  "EC-NODE-T013"(data) {
    exactKeys(data, ["sanitized", "credentialLeaked", "unsafe", "cache"], "T013 data");
    requireValue(data.sanitized === "https://registry.example.invalid/@scope/pkg/-/pkg-1.0.0.tgz" && data.credentialLeaked === false, "T013 registry credential leaked");
    requireValue(equal(data.unsafe, { traversal: "EC_NPM_ARCHIVE_PATH_UNSAFE", absolute: "EC_NPM_ARCHIVE_PATH_UNSAFE", device: "EC_NPM_ARCHIVE_PATH_UNSAFE", collision: "EC_NPM_ARCHIVE_PATH_COLLISION" }), "T013 archive validation differs");
    requireValue(equal(data.cache, { same: true, transformerDiffers: true }), "T013 cache identity is incomplete");
  },
  "EC-NODE-T014"(data) {
    exactKeys(data, ["packageCount", "installedOctets", "graphIdentity", "faultPoints", "runtimeMissingModule"], "T014 data");
    requireValue(data.packageCount === FIXTURE_PACKAGES && data.installedOctets === FIXTURE_INSTALLED_OCTETS && SHA256.test(data.graphIdentity), "T014 minimum graph boundary differs");
    requireValue(equal(data.faultPoints.map((value) => value.point), ["fetch", "verify", "transform", "commit"]) && data.faultPoints.every((value) => value.activeBefore === "deployment-old" && value.activeAfter === "deployment-old" && value.partialCommitted === false && value.verifiedCacheEntries === 0), "T014 build failure committed state");
    requireValue(equal(data.runtimeMissingModule, { code: "EC_NODE_ARTIFACT_INCOMPLETE", status: 500, repairAttempts: 0, hostFallbacks: 0 }), "T014 runtime attempted module repair or fallback");
  },
  "EC-NODE-T015"(data) {
    exactKeys(data, ["baselineDate", "mutations", "providers"], "T015 data");
    requireValue(data.baselineDate === "2026-09-04", "T015 baseline date differs");
    const codes = new Map([["higher-major", "EC_NODE_VERSION_UNSUPPORTED"], ["floating-standard", "EC_NODE_STANDARD_PIN_INVALID"], ["node-baseline", "EC_NODE_BASELINE_UNSUPPORTED"], ["extra-export", "EC_NODE_API_SET_INVALID"], ["condition-order", "EC_NODE_CONDITIONS_INVALID"], ["lock-policy", "EC_NPM_POLICY_INVALID"], ["unknown-field", "EC_NODE_DOCUMENT_INVALID"]]);
    requireValue(data.mutations.length === codes.size && data.mutations.every((value) => value.code === codes.get(value.variant) && value.applicationExecutions === 0), "T015 accepted a drifting lock");
    requireValue(equal(data.providers.map((value) => value.providerId), ["cloudflare-workers-pages", "tencent-edgeone-makers", "deislet"]), "T015 provider set differs");
    requireValue(data.providers.every((value) => value.nodeSemanticBaseline === "24.20.0" && value.handlerModel === "edge-canon-fetch-context" && value.npm === "locked-build-only" && value.unsupported === "reject-before-deploy"), "T015 provider surface differs");
    requireValue(data.providers[0].executor === "workers-native-plus-verified-shims" && data.providers[1].executor === "cloud-functions-api-node" && data.providers[2].executor === "deislet-node-compat-layer", "T015 provider implementation strategy differs");
  },
};

export function verifyCaseData(id, data) {
  const verifier = VERIFIERS[id];
  requireValue(verifier !== undefined, `unknown EC-NODE case ${id}`);
  verifier(data);
  return data;
}

export function verifyDocument(document) {
  exactKeys(document, ["schemaVersion", "standardId", "suiteId", "backend", "artifactSha256", "cases"], "observation document");
  requireValue(document.schemaVersion === 1 && document.standardId === "edge-canon.next" && document.suiteId === "EC-NODE", "observation identity differs");
  requireValue(SHA256.test(document.artifactSha256), "capability lock digest is invalid");
  exactKeys(document.backend, ["id", "implementationVersion", "standardVersion"], "backend");
  requireValue(document.backend.id === "edge-canon-reference-node" && document.backend.implementationVersion === "edge-canon-reference-node-harness/1" && EXACT_STANDARD.test(document.backend.standardVersion), "reference backend identity differs");
  const byId = new Map();
  for (const item of document.cases ?? []) {
    exactKeys(item, ["id", "observedAt", "data", "evidenceRefs"], "case record");
    requireValue(!byId.has(item.id), `duplicate case ${item.id}`);
    requireValue(Number.isFinite(Date.parse(item.observedAt)) && Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0 && new Set(item.evidenceRefs).size === item.evidenceRefs.length, `${item.id} metadata is invalid`);
    byId.set(item.id, item);
  }
  requireValue(byId.size === EXPECTED_CASES.length && EXPECTED_CASES.every((id) => byId.has(id)), "draft harness requires exactly fifteen Node/npm cases");
  for (const id of EXPECTED_CASES) verifyCaseData(id, byId.get(id).data);
  return { suiteId: "EC-NODE", status: "pass", caseIds: [...EXPECTED_CASES] };
}

function main(file) {
  requireValue(file, "usage: node oracle.mjs OBSERVATIONS.json");
  process.stdout.write(`${JSON.stringify(verifyDocument(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2)}\n`);
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  try { main(process.argv[2]); } catch (error) { process.stderr.write(`EC-NODE oracle failed: ${error.message}\n`); process.exitCode = 1; }
}
