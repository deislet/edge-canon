import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { capacityDocument, fixtureDocument, fixtureFiles } from "./fixture.mjs";
import { RoutingError, resolveRequest, validateRoutingDocument } from "./reference-router.mjs";

const CASE_IDS = Array.from({ length: 11 }, (_, index) => `EC-ROUTING-T${String(index + 1).padStart(3, "0")}`);
const EMPTY_SHA256 = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function documentIdentity(document) {
  return sha256(Buffer.from(JSON.stringify(stableValue(document)), "utf8"));
}

function cloneDocument(document) {
  return structuredClone(document);
}

function cloneFiles(files) {
  return new Map([...files].map(([name, file]) => [name, { ...file, bytes: Buffer.from(file.bytes) }]));
}

function resolveStandardVersion(explicit) {
  if (explicit) return explicit;
  if (process.env.EDGE_CANON_STANDARD_VERSION) return process.env.EDGE_CANON_STANDARD_VERSION;
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: new URL("../../..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return `edge-canon.next@${commit}`;
}

function record(id, data) {
  return {
    id,
    observedAt: new Date().toISOString(),
    data,
    evidenceRefs: [`local:routing-static-assets/${id}`],
  };
}

function captureValidation(document, files, expectedStandardVersion) {
  try {
    validateRoutingDocument(document, files, expectedStandardVersion);
    return { code: null, message: null };
  } catch (error) {
    if (!(error instanceof RoutingError)) throw error;
    return { code: error.code, message: error.message };
  }
}

function captureRequest(document, files, request, expectedStandardVersion) {
  try {
    return { status: 200, code: null, result: resolveRequest(document, files, request, { expectedStandardVersion }), message: null };
  } catch (error) {
    if (!(error instanceof RoutingError)) throw error;
    return { status: error.code === "EC_ROUTING_PATH_INVALID" ? 400 : 500, code: error.code, result: null, message: error.message };
  }
}

function outcome(result) {
  return {
    kind: result.kind,
    status: result.status,
    location: result.location,
    entrypointId: result.entrypointId,
    headerRuleId: result.headerRuleId,
    bodySha256: result.bodySha256,
    representationSha256: result.representationSha256,
    routedPathname: result.routedPathname,
    routedQuery: result.routedQuery,
    trace: result.trace,
  };
}

class CountingMap extends Map {
  constructor(value) {
    super(value);
    this.reads = 0;
  }

  get(key) {
    this.reads += 1;
    return super.get(key);
  }
}

export async function runSuite(options = {}) {
  const standardVersion = resolveStandardVersion(options.standardVersion);
  if (!/^edge-canon\.next@[0-9a-f]{40}$/.test(standardVersion)) throw new Error("an exact Edge Canon commit is required");
  const files = fixtureFiles();
  const document = fixtureDocument(standardVersion, { files });
  validateRoutingDocument(document, files, standardVersion);
  const artifactSha256 = documentIdentity(document);
  const cases = [];

  const redirect = resolveRequest(document, files, { pathname: "/old/7", query: "from=old", method: "GET" }, { expectedStandardVersion: standardVersion });
  const rewritten = resolveRequest(document, files, { pathname: "/legacy/42", query: "source=legacy", method: "GET" }, { expectedStandardVersion: standardVersion });
  const collision = resolveRequest(document, files, { pathname: "/same", method: "GET" }, { expectedStandardVersion: standardVersion });
  const fallback = resolveRequest(document, files, { pathname: "/absent", method: "GET" }, { expectedStandardVersion: standardVersion });
  cases.push(record(CASE_IDS[0], {
    redirect: outcome(redirect),
    rewritten: outcome(rewritten),
    assetFunctionCollision: outcome(collision),
    fallback: outcome(fallback),
  }));

  const parameter = resolveRequest(document, files, { pathname: "/old/Value", query: "x=1", method: "GET" }, { expectedStandardVersion: standardVersion });
  const multiSegment = resolveRequest(document, files, { pathname: "/old/one/two", method: "GET" }, { expectedStandardVersion: standardVersion });
  const splatOne = resolveRequest(document, files, { pathname: "/files/One/two", query: "x=1", method: "GET" }, { expectedStandardVersion: standardVersion });
  const splatTwo = resolveRequest(document, files, { pathname: "/files/One/two", query: "x=2", method: "GET" }, { expectedStandardVersion: standardVersion });
  const wrongCase = resolveRequest(document, files, { pathname: "/Files/One/two", method: "GET" }, { expectedStandardVersion: standardVersion });
  cases.push(record(CASE_IDS[1], {
    parameter: { location: parameter.location, params: parameter.params },
    multiSegmentKind: multiSegment.kind,
    splat: { first: splatOne.params, second: splatTwo.params, entrypointIds: [splatOne.entrypointId, splatTwo.entrypointId] },
    queryExcludedFromMatch: splatOne.entrypointId === splatTwo.entrypointId && JSON.stringify(splatOne.params) === JSON.stringify(splatTwo.params),
    wrongCaseKind: wrongCase.kind,
  }));

  const getAsset = resolveRequest(document, files, { pathname: "/about", method: "GET" }, { expectedStandardVersion: standardVersion });
  const headAsset = resolveRequest(document, files, { pathname: "/about", method: "HEAD" }, { expectedStandardVersion: standardVersion });
  cases.push(record(CASE_IDS[2], {
    get: { status: getAsset.status, headers: getAsset.headers, bodySha256: getAsset.bodySha256, representationSha256: getAsset.representationSha256, bodySize: getAsset.bodySize },
    head: { status: headAsset.status, headers: headAsset.headers, bodySha256: headAsset.bodySha256, representationSha256: headAsset.representationSha256, bodySize: headAsset.bodySize },
    emptySha256: EMPTY_SHA256,
  }));

  const internalRedirect = resolveRequest(document, files, { pathname: "/old/9", query: "keep=yes", method: "GET" }, { expectedStandardVersion: standardVersion });
  const externalRedirect = resolveRequest(document, files, { pathname: "/docs", query: "drop=yes", method: "GET" }, { expectedStandardVersion: standardVersion });
  cases.push(record(CASE_IDS[3], {
    internal: outcome(internalRedirect),
    external: outcome(externalRedirect),
    laterStageCount: 0,
  }));

  const sentinel = Buffer.from("post-body-sentinel\n", "utf8");
  const postRewrite = resolveRequest(document, files, { pathname: "/legacy/42", query: "keep=yes", method: "POST", body: sentinel }, { expectedStandardVersion: standardVersion });
  const unmatched = resolveRequest(document, files, { pathname: "/missing", method: "POST", body: sentinel }, { expectedStandardVersion: standardVersion });
  cases.push(record(CASE_IDS[4], {
    rewritten: outcome(postRewrite),
    method: postRewrite.method,
    requestBodySha256: postRewrite.requestBodySha256,
    expectedBodySha256: sha256(sentinel),
    rewriteCount: postRewrite.trace.filter((value) => value.startsWith("rewrite:")).length,
    unmatched: outcome(unmatched),
    originHitCount: 0,
  }));

  const staticHeaders = resolveRequest(document, files, { pathname: "/same", method: "GET" }, { expectedStandardVersion: standardVersion });
  const functionHeaders = resolveRequest(document, files, { pathname: "/same", method: "POST" }, { expectedStandardVersion: standardVersion });
  const headerMutations = [];
  for (const [variant, mutate] of [
    ["crlf", (value) => { value.headers[0].values[0].value = "safe\r\nX-Injection: yes"; }],
    ["set-cookie", (value) => { value.headers[0].values[0].name = "Set-Cookie"; }],
    ["dynamic-authority", (value) => {
      value.redirects[2].source = "/jump/:host";
      value.redirects[2].destination.value = "https://:host.example.test/guide";
    }],
  ]) {
    const mutated = cloneDocument(document);
    mutate(mutated);
    headerMutations.push({ variant, ...captureValidation(mutated, cloneFiles(files), standardVersion) });
  }
  cases.push(record(CASE_IDS[5], {
    selectedHeaderRule: staticHeaders.headerRuleId,
    staticHeaders: staticHeaders.headers,
    functionHeaders: functionHeaders.headers,
    mutations: headerMutations.map(({ variant, code }) => ({ variant, code })),
  }));

  const fallbackResults = [];
  for (const fallbackValue of [
    { kind: "not-found" },
    { kind: "custom-404", filePath: "static/404.html" },
    { kind: "spa", filePath: "static/index.html" },
  ]) {
    const fallbackDocument = cloneDocument(document);
    fallbackDocument.fallback = fallbackValue;
    const first = resolveRequest(fallbackDocument, files, { pathname: "/missing", method: "GET" }, { expectedStandardVersion: standardVersion });
    const second = resolveRequest(fallbackDocument, files, { pathname: "/missing", method: "GET", headers: { "user-agent": "navigation-client" } }, { expectedStandardVersion: standardVersion });
    fallbackResults.push({ kind: fallbackValue.kind, first: outcome(first), headerVariantSame: JSON.stringify(outcome(first)) === JSON.stringify(outcome(second)) });
  }
  cases.push(record(CASE_IDS[6], { fallbacks: fallbackResults, originHitCount: 0 }));

  const requestMutations = ["/%", "/a/%2F/b", "/a/%5c/b", "/a/%00/b", "/a/%2e%2e/b", "/a/../b", "/a\\b"].map((pathname) => {
    const result = captureRequest(document, files, { pathname, method: "GET" }, standardVersion);
    return { variantSha256: sha256(Buffer.from(pathname, "utf8")), status: result.status, code: result.code, terminal: result.result?.kind ?? null };
  });
  const diagnosticCanary = "EC_SECRET_CANARY_671cfacdb8c74ec4";
  const artifactMutations = [];
  for (const [variant, mutate] of [
    ["traversal", (value) => { value.document.assets[0].filePath = `../${diagnosticCanary}`; }],
    ["link", (value) => { const name = value.document.assets[0].filePath; value.files.set(name, { type: "symlink", bytes: Buffer.alloc(0) }); }],
    ["missing", (value) => { value.files.delete(value.document.assets[0].filePath); }],
    ["digest", (value) => { value.document.assets[0].sha256 = "0".repeat(64); }],
    ["unlisted", (value) => { value.files.set(`static/${diagnosticCanary}.txt`, { type: "file", bytes: Buffer.from("unlisted") }); }],
  ]) {
    const value = { document: cloneDocument(document), files: cloneFiles(files) };
    mutate(value);
    artifactMutations.push({ variant, ...captureValidation(value.document, value.files, standardVersion) });
  }
  const diagnosticMessages = artifactMutations.map((value) => value.message).filter(Boolean);
  cases.push(record(CASE_IDS[7], {
    requests: requestMutations,
    artifacts: artifactMutations.map(({ variant, code }) => ({ variant, code })),
    providerDerivationCount: 0,
    diagnosticsSanitized: diagnosticMessages.every((value) => !value.includes("/ext/") && !value.includes(diagnosticCanary)),
  }));

  const oldFiles = fixtureFiles("old");
  const newFiles = fixtureFiles("new");
  const oldDocument = fixtureDocument(standardVersion, { files: oldFiles });
  const newDocument = fixtureDocument(standardVersion, { files: newFiles });
  const oldIdentity = documentIdentity(oldDocument);
  const newIdentity = documentIdentity(newDocument);
  const snapshots = [{ identity: oldIdentity, document: oldDocument, files: oldFiles }, { identity: newIdentity, document: newDocument, files: newFiles }];
  const concurrent = await Promise.all(Array.from({ length: 64 }, async (_, index) => {
    const snapshot = snapshots[index % 2];
    const result = resolveRequest(snapshot.document, snapshot.files, { pathname: "/same", method: "GET" }, { expectedStandardVersion: standardVersion });
    return { identity: snapshot.identity, representationSha256: result.representationSha256 };
  }));
  const expectedPairs = snapshots.map((snapshot) => {
    const result = resolveRequest(snapshot.document, snapshot.files, { pathname: "/same", method: "GET" }, { expectedStandardVersion: standardVersion });
    return `${snapshot.identity}:${result.representationSha256}`;
  });
  const mixedFailures = [
    captureValidation(oldDocument, newFiles, standardVersion).code,
    captureValidation(newDocument, oldFiles, standardVersion).code,
  ];
  cases.push(record(CASE_IDS[8], {
    oldIdentity,
    newIdentity,
    requestCount: concurrent.length,
    observedPairs: [...new Set(concurrent.map((value) => `${value.identity}:${value.representationSha256}`))].sort(),
    expectedPairs: [...expectedPairs].sort(),
    mixedPairCount: concurrent.filter((value) => !expectedPairs.includes(`${value.identity}:${value.representationSha256}`)).length,
    mixedSnapshotValidationCodes: mixedFailures,
  }));

  const capacity = capacityDocument(standardVersion);
  capacity.document.fallback = { kind: "spa", filePath: "static/index.html" };
  validateRoutingDocument(capacity.document, capacity.files, standardVersion);
  const longSource = capacity.document.redirects[49].source;
  const lastRedirect = resolveRequest(capacity.document, capacity.files, { pathname: longSource, method: "GET" }, { expectedStandardVersion: standardVersion });
  const lastRewrite = resolveRequest(capacity.document, capacity.files, { pathname: "/rewrite-49", method: "GET" }, { expectedStandardVersion: standardVersion });
  const lastHeader = resolveRequest(capacity.document, capacity.files, { pathname: "/header-29", method: "GET" }, { expectedStandardVersion: standardVersion });
  const overLimitDocument = cloneDocument(capacity.document);
  overLimitDocument.headers[0].values.push({ name: "X-Over-Limit", value: "rejected" });
  const overLimitCode = captureValidation(overLimitDocument, cloneFiles(capacity.files), standardVersion).code;
  cases.push(record(CASE_IDS[9], {
    acceptedCounts: { transforms: capacity.document.redirects.length + capacity.document.rewrites.length, headerRules: capacity.document.headers.length, headersPerRule: capacity.document.headers[29].values.length },
    maximumSourceLength: longSource.length,
    maximumDestinationLengths: [capacity.document.redirects[49].destination.value.length, capacity.document.rewrites[49].destination.length],
    maximumHeaderLengths: [capacity.document.headers[29].values[29].name.length, capacity.document.headers[29].values[29].value.length],
    lastRedirect: outcome(lastRedirect),
    lastRewrite: outcome(lastRewrite),
    lastHeader: { outcome: outcome(lastHeader), valueCount: lastHeader.headers.length - 2 },
    overLimitCode,
  }));

  const versions = [];
  for (const [variant, mutate, expected] of [
    ["higher-major", (value) => { value.format = "edge-canon.routing-static-assets/v2"; }, "EC_ROUTING_VERSION_UNSUPPORTED"],
    ["floating-standard", (value) => { value.standardVersion = "edge-canon.next"; }, "EC_ROUTING_STANDARD_PIN_INVALID"],
    ["unknown-field", (value) => { value.provider = "vendor"; }, "EC_ROUTING_DOCUMENT_INVALID"],
    ["nested-unknown-field", (value) => { value.matching.$schema = "unexpected"; }, "EC_ROUTING_DOCUMENT_INVALID"],
  ]) {
    const mutated = cloneDocument(document);
    mutate(mutated);
    const countingFiles = new CountingMap(cloneFiles(files));
    const failure = captureValidation(mutated, countingFiles, standardVersion);
    versions.push({ variant, code: failure.code, expected, assetReadsBeforeRejection: countingFiles.reads });
  }
  const sourceBefore = JSON.stringify(document);
  const migrated = cloneDocument(document);
  const migratedStandardVersion = `edge-canon.next@${"1".repeat(40)}`;
  migrated.standardVersion = migratedStandardVersion;
  migrated.redirects[0].status = 302;
  validateRoutingDocument(migrated, files, migratedStandardVersion);
  const oldOutcome = resolveRequest(document, files, { pathname: "/old/1", method: "GET" }, { expectedStandardVersion: standardVersion });
  const newOutcome = resolveRequest(migrated, files, { pathname: "/old/1", method: "GET" }, { expectedStandardVersion: migratedStandardVersion });
  cases.push(record(CASE_IDS[10], {
    versions,
    sourceIdentity: artifactSha256,
    migratedIdentity: documentIdentity(migrated),
    sourceMutated: sourceBefore !== JSON.stringify(document),
    outcomeDiff: { routeId: "old-first", beforeStatus: oldOutcome.status, afterStatus: newOutcome.status },
  }));

  return {
    schemaVersion: 1,
    standardId: "edge-canon.next",
    suiteId: "EC-ROUTING",
    backend: {
      id: "edge-canon-reference-router",
      implementationVersion: "edge-canon-reference-routing-harness/1",
      standardVersion,
    },
    artifactSha256,
    cases,
  };
}

async function main() {
  process.stdout.write(`${JSON.stringify(await runSuite(), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`EC-ROUTING runner failed: ${error.code ?? "EC_ROUTING_RUNNER_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
