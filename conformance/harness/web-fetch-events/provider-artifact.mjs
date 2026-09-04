import fs from "node:fs";
import path from "node:path";

import { serializeArtifactManifest, sha256 } from "./canonical-artifact.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const PROJECT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EXPECTED_CANONICAL_FILES = ["cpu-workload.mjs", "fixture.mjs"];
const DERIVED_MANIFEST = "edge-canon-derived-artifact.json";

export class ProviderArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderArtifactError";
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (!condition) throw new ProviderArtifactError(code, message);
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys, label) {
  fail(value && typeof value === "object" && !Array.isArray(value), "EC_ADAPTER_ARTIFACT_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort(comparePath);
  const expected = [...keys].sort(comparePath);
  fail(JSON.stringify(actual) === JSON.stringify(expected), "EC_ADAPTER_ARTIFACT_INVALID", `${label} keys differ`);
}

function safeRelative(relativePath, label) {
  fail(typeof relativePath === "string" && relativePath.length > 0, "EC_ADAPTER_ARTIFACT_INVALID", `${label} is empty`);
  fail(!relativePath.includes("\\") && !path.posix.isAbsolute(relativePath), "EC_ADAPTER_ARTIFACT_INVALID", `${label} is not a portable relative path`);
  const parts = relativePath.split("/");
  fail(parts.every((part) => part && part !== "." && part !== ".."), "EC_ADAPTER_ARTIFACT_INVALID", `${label} contains an unsafe segment`);
  return parts;
}

function readJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ProviderArtifactError("EC_ADAPTER_ARTIFACT_INVALID", `${label} is not JSON: ${error.message}`);
  }
}

function requirePlainDirectory(directory, label) {
  const status = fs.lstatSync(directory, { throwIfNoEntry: false });
  fail(status?.isDirectory() && !status.isSymbolicLink(), "EC_ADAPTER_ARTIFACT_INVALID", `${label} is not a regular directory`);
  const resolved = path.resolve(directory);
  fail(fs.realpathSync(directory) === resolved, "EC_ADAPTER_ARTIFACT_INVALID", `${label} traverses a symbolic link`);
  return resolved;
}

function containsOrEquals(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return containsOrEquals(left, right) || containsOrEquals(right, left);
}

function collectTree(root, relative = "") {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  const names = fs.readdirSync(directory).sort(comparePath);
  const files = [];
  for (const name of names) {
    const childRelative = relative ? `${relative}/${name}` : name;
    const child = path.join(root, ...childRelative.split("/"));
    const status = fs.lstatSync(child);
    fail(!status.isSymbolicLink(), "EC_ADAPTER_ARTIFACT_INVALID", `artifact contains symbolic link ${childRelative}`);
    if (status.isDirectory()) files.push(...collectTree(root, childRelative));
    else {
      fail(status.isFile(), "EC_ADAPTER_ARTIFACT_INVALID", `artifact contains non-file ${childRelative}`);
      files.push(childRelative);
    }
  }
  return files;
}

function validateFileEntries(root, entries, manifestName) {
  fail(Array.isArray(entries) && entries.length > 0, "EC_ADAPTER_ARTIFACT_INVALID", "artifact files must be a non-empty array");
  const names = [];
  const contents = new Map();
  for (const [index, entry] of entries.entries()) {
    exactKeys(entry, ["path", "size", "sha256"], `files[${index}]`);
    const parts = safeRelative(entry.path, `files[${index}].path`);
    fail(Number.isSafeInteger(entry.size) && entry.size >= 0, "EC_ADAPTER_ARTIFACT_INVALID", `${entry.path} size is invalid`);
    fail(typeof entry.sha256 === "string" && SHA256.test(entry.sha256), "EC_ADAPTER_ARTIFACT_INVALID", `${entry.path} digest is invalid`);
    fail(!names.includes(entry.path), "EC_ADAPTER_ARTIFACT_INVALID", `duplicate artifact file ${entry.path}`);
    const filePath = path.join(root, ...parts);
    const status = fs.lstatSync(filePath, { throwIfNoEntry: false });
    fail(status?.isFile() && !status.isSymbolicLink(), "EC_ADAPTER_ARTIFACT_INVALID", `${entry.path} is not a regular file`);
    const bytes = fs.readFileSync(filePath);
    fail(bytes.byteLength === entry.size, "EC_ADAPTER_ARTIFACT_INVALID", `${entry.path} size differs`);
    fail(sha256(bytes) === entry.sha256, "EC_ADAPTER_ARTIFACT_INVALID", `${entry.path} digest differs`);
    names.push(entry.path);
    contents.set(entry.path, bytes);
  }
  fail(JSON.stringify(names) === JSON.stringify([...names].sort(comparePath)), "EC_ADAPTER_ARTIFACT_INVALID", "artifact files are not in canonical order");
  const actual = collectTree(root).filter((name) => name !== manifestName);
  fail(JSON.stringify(actual) === JSON.stringify(names), "EC_ADAPTER_ARTIFACT_INVALID", "artifact tree differs from its manifest");
  return contents;
}

export function validateCanonicalArtifact(request) {
  const manifestPath = request.canonicalArtifact.path;
  const manifestStatus = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  fail(manifestStatus?.isFile() && !manifestStatus.isSymbolicLink(), "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact manifest is not a regular file");
  fail(path.basename(manifestPath) === "edge-canon-canonical-artifact.json", "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact manifest name differs");
  fail(fs.realpathSync(manifestPath) === path.resolve(manifestPath), "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact path traverses a symbolic link");
  const bytes = fs.readFileSync(manifestPath);
  fail(sha256(bytes) === request.canonicalArtifact.sha256, "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact manifest digest differs");
  const manifest = readJson(bytes, "canonical artifact manifest");
  exactKeys(manifest, ["schemaVersion", "artifactFormat", "standardVersion", "suiteId", "entrypoint", "files"], "canonical artifact manifest");
  fail(manifest.schemaVersion === 1, "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact schemaVersion differs");
  fail(manifest.artifactFormat === "edge-canon.canonical-artifact/v1", "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact format differs");
  fail(manifest.standardVersion === request.standardVersion, "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact standardVersion differs");
  fail(manifest.suiteId === request.suiteId, "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact suiteId differs");
  fail(manifest.entrypoint === "fixture.mjs", "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact entrypoint differs");
  const root = requirePlainDirectory(path.dirname(manifestPath), "canonical artifact directory");
  const contents = validateFileEntries(root, manifest.files, path.basename(manifestPath));
  fail(
    JSON.stringify([...contents.keys()]) === JSON.stringify(EXPECTED_CANONICAL_FILES),
    "EC_ADAPTER_ARTIFACT_INVALID",
    "canonical artifact file set differs from EC-WEB v1",
  );
  return { manifest, contents, root };
}

function jsonFile(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function wrapperPrelude(backendId, configuration) {
  return `import handler from "../canonical/fixture.mjs";

const BACKEND_ID = "${backendId}";
const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVIDENCE_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const EVIDENCE_SINK_URL = ${JSON.stringify(configuration.evidenceSinkUrl)};
const HARNESS_ENVIRONMENT = Object.freeze(${JSON.stringify({
    TEST_VALUE: "edge-canon-env",
    CPU_ITERATIONS: String(configuration.cpuIterations),
    CONTROLLED_ORIGIN: configuration.controlledOriginUrl,
    CONNECTION_BARRIER_ORIGIN: configuration.connectionBarrierOriginUrl,
  })});

function emitEvidence(event, fields, token, enabled = true) {
  if (!enabled) return Promise.resolve();
  const record = Object.assign({
    schemaVersion: 1,
    backendId: BACKEND_ID,
    event,
  }, fields);
  try {
    console.log("EDGE_CANON_EVIDENCE " + JSON.stringify(record));
  } catch {
    // collect observes missing evidence; evidence transport cannot alter HTTP output.
  }
  if (!EVIDENCE_TOKEN.test(token ?? "")) return Promise.resolve();
  return fetch(EVIDENCE_SINK_URL, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify(record),
  }).then((response) => {
    if (!response.ok) throw new Error("evidence sink rejected the record");
  }).catch(() => undefined);
}

function standardFailureResponse() {
  return new Response("Internal Server Error\\n", {
    status: 500,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function standardContext(request, nativeEnvironment, nativeWaitUntil) {
  if (typeof nativeWaitUntil !== "function") {
    throw new TypeError("provider context does not expose waitUntil");
  }
  const suppliedInvocationId = request.headers.get("x-edge-canon-invocation-id");
  const suppliedEvidenceToken = request.headers.get("x-edge-canon-evidence-token");
  const evidenceEnabled = request.headers.get("x-edge-canon-evidence-mode") !== "off";
  const invocationId = INVOCATION_ID.test(suppliedInvocationId ?? "")
    ? suppliedInvocationId
    : null;
  const evidenceToken = EVIDENCE_TOKEN.test(suppliedEvidenceToken ?? "")
    ? suppliedEvidenceToken
    : null;
  const applicationHeaders = new Headers(request.headers);
  applicationHeaders.delete("x-edge-canon-invocation-id");
  applicationHeaders.delete("x-edge-canon-evidence-token");
  applicationHeaders.delete("x-edge-canon-evidence-mode");
  const applicationRequest = new Request(request, { headers: applicationHeaders });
  let closed = false;
  let registeredBackgroundTaskCount = 0;
  function deliver(event, fields) {
    const delivery = emitEvidence(event, fields, evidenceToken, evidenceEnabled);
    try {
      nativeWaitUntil(delivery);
    } catch {
      // The sink request has already started; collect will reject missing evidence.
    }
    return delivery;
  }
  const evidence = Object.freeze({
    record(marker) {
      return emitEvidence("record", {
        invocationId,
        marker: String(marker).slice(0, 256),
      }, evidenceToken, evidenceEnabled);
    },
  });
  const env = Object.assign({}, HARNESS_ENVIRONMENT);
  Object.defineProperty(env, "EVIDENCE", {
    value: evidence,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  Object.freeze(env);
  const context = {
    request: applicationRequest,
    env,
    params: { name: "edge-canon-param" },
    waitUntil(promise) {
      if (closed) {
        deliver("failure", { invocationId, failureCode: "EC_WAIT_UNTIL_CLOSED" });
        const error = new TypeError("waitUntil cannot register work after the response lifecycle closed");
        Object.defineProperty(error, "code", { value: "EC_WAIT_UNTIL_CLOSED" });
        throw error;
      }
      registeredBackgroundTaskCount += 1;
      const taskNumber = registeredBackgroundTaskCount;
      deliver("background-registered", { invocationId, taskNumber });
      const tracked = Promise.resolve(promise).catch(() => deliver("failure", {
          invocationId,
          taskNumber,
          failureCode: "EC_BACKGROUND_REJECTED",
        }));
      nativeWaitUntil(tracked);
    },
  };
  deliver("invocation-start", {
    invocationId,
    method: applicationRequest.method,
    pathname: new URL(applicationRequest.url).pathname,
  });
  return {
    context,
    close(terminalState) {
      if (closed) return;
      closed = true;
      deliver("lifecycle-closed", {
        invocationId,
        registeredBackgroundTaskCount,
        terminalState,
      });
    },
    failure(failureCode) {
      deliver("failure", { invocationId, failureCode });
    },
    settled() {
      deliver("handler-settled", { invocationId });
    },
    invocationId,
  };
}

function lifecycleResponse(response, lifecycle) {
  if (response.body === null) {
    lifecycle.close("no-body");
    return response;
  }
  let reader;
  try {
    reader = response.body.getReader();
  } catch {
    lifecycle.close("errored");
    throw new TypeError("handler response body cannot be consumed");
  }
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          lifecycle.close("closed");
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        lifecycle.close("errored");
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        lifecycle.close("cancelled");
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function dispatchHandler(request, nativeEnvironment, nativeWaitUntil) {
  let lifecycle;
  try {
    lifecycle = standardContext(request, nativeEnvironment, nativeWaitUntil);
  } catch {
    const delivery = emitEvidence("failure", { invocationId: null, failureCode: "EC_PROVIDER_CONTEXT_INVALID" }, null);
    try {
      nativeWaitUntil(delivery);
    } catch {
      // There is no valid provider context to retain this best-effort record.
    }
    return standardFailureResponse();
  }
  let result;
  try {
    result = await handler(lifecycle.context);
  } catch {
    lifecycle.failure("EC_HANDLER_THROWN");
    result = standardFailureResponse();
  }
  if (!(result instanceof Response)) {
    lifecycle.failure("EC_HANDLER_RESULT_INVALID");
    result = standardFailureResponse();
  }
  lifecycle.settled();
  try {
    return lifecycleResponse(result, lifecycle);
  } catch {
    lifecycle.failure("EC_HANDLER_RESULT_INVALID");
    return lifecycleResponse(standardFailureResponse(), lifecycle);
  }
}

`;
}

function providerFiles(backendId, canonical, configuration) {
  const { projectName, compatibilityDate } = configuration;
  const files = new Map([
    ["canonical/cpu-workload.mjs", canonical.contents.get("cpu-workload.mjs")],
    ["canonical/fixture.mjs", canonical.contents.get("fixture.mjs")],
  ]);
  if (backendId === "cloudflare-workers-pages") {
    files.set("src/index.mjs", Buffer.from(`${wrapperPrelude(backendId, configuration)}export default {
  fetch(request, env, executionContext) {
    return dispatchHandler(request, env, executionContext.waitUntil.bind(executionContext));
  },
};
`, "utf8"));
    files.set("wrangler.json", jsonFile({
      $schema: "node_modules/wrangler/config-schema.json",
      name: projectName,
      main: "src/index.mjs",
      compatibility_date: compatibilityDate,
      workers_dev: true,
    }));
    return { entrypoint: "src/index.mjs", files };
  }
  if (backendId === "tencent-edgeone-makers") {
    files.set("edge-functions/[[default]].js", Buffer.from(`${wrapperPrelude(backendId, configuration)}export default function onRequest(context) {
  return dispatchHandler(
    context.request,
    context.env,
    context.waitUntil.bind(context),
  );
}
`, "utf8"));
    files.set("edgeone.json", jsonFile({ name: projectName }));
    files.set("package.json", jsonFile({
      name: projectName,
      version: "0.0.0",
      private: true,
      type: "module",
    }));
    return { entrypoint: "edge-functions/[[default]].js", files };
  }
  if (backendId === "deislet") {
    files.set("functions/[[all]].js", Buffer.from(`${wrapperPrelude(backendId, configuration)}export default function onRequest(context) {
  return dispatchHandler(
    context.request,
    context.env,
    context.waitUntil.bind(context),
  );
}
`, "utf8"));
    files.set(".config.json", jsonFile({
      version: "1.0.0",
      name: projectName,
      runtime: "standard-v1",
      language: "javascript",
      functionRoot: "./functions",
      compatibilityDate,
      vendors: { deislet: { enabled: true } },
      build: { outDir: "./dist" },
    }));
    files.set("package.json", jsonFile({
      name: projectName,
      version: "0.0.0",
      private: true,
      type: "module",
    }));
    return { entrypoint: "functions/[[all]].js", files };
  }
  throw new ProviderArtifactError("EC_ADAPTER_ARTIFACT_INVALID", `unsupported backend ${backendId}`);
}

function validateCompatibilityDate(value) {
  fail(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), "EC_ADAPTER_CONFIGURATION_INVALID", "compatibilityDate must be YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00Z`);
  fail(!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value, "EC_ADAPTER_CONFIGURATION_INVALID", "compatibilityDate is not a calendar date");
}

function validateHarnessUrl(value, label) {
  fail(typeof value === "string", "EC_ADAPTER_CONFIGURATION_INVALID", `${label} must be a URL string`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ProviderArtifactError("EC_ADAPTER_CONFIGURATION_INVALID", `${label} is invalid: ${error.message}`);
  }
  const loopback = parsed.protocol === "http:"
    && ["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname);
  fail(parsed.protocol === "https:" || loopback, "EC_ADAPTER_CONFIGURATION_INVALID", `${label} must use HTTPS or HTTP loopback`);
  fail(
    !parsed.username && !parsed.password && !parsed.hash && !parsed.search,
    "EC_ADAPTER_CONFIGURATION_INVALID",
    `${label} must not contain credentials, a query, or a fragment`,
  );
  return parsed.href;
}

export function validateHarnessConfiguration(input) {
  const configuration = { ...input };
  configuration.evidenceSinkUrl = validateHarnessUrl(configuration.evidenceSinkUrl, "evidenceSinkUrl");
  configuration.controlledOriginUrl = validateHarnessUrl(configuration.controlledOriginUrl, "controlledOriginUrl");
  configuration.connectionBarrierOriginUrl = validateHarnessUrl(configuration.connectionBarrierOriginUrl, "connectionBarrierOriginUrl");
  fail(
    Number.isSafeInteger(configuration.cpuIterations)
      && configuration.cpuIterations > 0
      && configuration.cpuIterations <= 100_000_000,
    "EC_ADAPTER_CONFIGURATION_INVALID",
    "cpuIterations must be an integer between 1 and 100000000",
  );
  return configuration;
}

function validatePrepareConfiguration(request) {
  const configuration = validateHarnessConfiguration(request.configuration);
  fail(PROJECT_NAME.test(configuration.projectName), "EC_ADAPTER_CONFIGURATION_INVALID", "projectName must be a portable lowercase DNS label");
  validateCompatibilityDate(configuration.compatibilityDate);
  fail(typeof configuration.derivedDirectory === "string" && path.isAbsolute(configuration.derivedDirectory), "EC_ADAPTER_CONFIGURATION_INVALID", "derivedDirectory must be absolute");
  fail(path.resolve(configuration.derivedDirectory) === configuration.derivedDirectory, "EC_ADAPTER_CONFIGURATION_INVALID", "derivedDirectory must be normalized");
  const work = requirePlainDirectory(request.workDirectory, "workDirectory");
  const evidence = requirePlainDirectory(request.evidenceDirectory, "evidenceDirectory");
  const relative = path.relative(work, configuration.derivedDirectory);
  fail(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "EC_ADAPTER_CONFIGURATION_INVALID", "derivedDirectory must be a strict descendant of workDirectory");
  const parent = requirePlainDirectory(path.dirname(configuration.derivedDirectory), "derivedDirectory parent");
  const parentRelative = path.relative(work, parent);
  fail(parentRelative !== ".." && !parentRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(parentRelative), "EC_ADAPTER_CONFIGURATION_INVALID", "derivedDirectory parent escapes workDirectory");
  fail(!pathsOverlap(configuration.derivedDirectory, evidence), "EC_ADAPTER_CONFIGURATION_INVALID", "derivedDirectory and evidenceDirectory must not overlap");
  return configuration;
}

function buildExpected(request, manifest, canonical, configuration) {
  const generated = providerFiles(manifest.backendId, canonical, configuration);
  const files = [...generated.files.entries()]
    .map(([relativePath, bytes]) => ({ path: relativePath, size: bytes.byteLength, sha256: sha256(bytes) }))
    .sort((left, right) => comparePath(left.path, right.path));
  const derivedManifest = {
    schemaVersion: 1,
    artifactFormat: "edge-canon.provider-derived-artifact/v1",
    standardVersion: request.standardVersion,
    suiteId: request.suiteId,
    backendId: manifest.backendId,
    canonicalArtifactSha256: request.canonicalArtifact.sha256,
    inputs: {
      projectName: configuration.projectName,
      compatibilityDate: configuration.compatibilityDate,
    },
    entrypoint: generated.entrypoint,
    files,
  };
  return { ...generated, manifest: derivedManifest, manifestBytes: serializeArtifactManifest(derivedManifest) };
}

function writeTree(root, expected) {
  fs.chmodSync(root, 0o700);
  for (const [relativePath, bytes] of expected.files) {
    const target = path.join(root, ...safeRelative(relativePath, relativePath));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    fs.chmodSync(target, 0o600);
  }
  const manifestPath = path.join(root, DERIVED_MANIFEST);
  fs.writeFileSync(manifestPath, expected.manifestBytes, { flag: "wx", mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);
}

function validateExisting(root, expected) {
  requirePlainDirectory(root, "derivedDirectory");
  const actualTree = collectTree(root);
  const expectedTree = [...expected.files.keys(), DERIVED_MANIFEST].sort(comparePath);
  fail(JSON.stringify(actualTree) === JSON.stringify(expectedTree), "EC_ADAPTER_ARTIFACT_CONFLICT", "existing derived artifact tree differs");
  const actualManifest = fs.readFileSync(path.join(root, DERIVED_MANIFEST));
  fail(actualManifest.equals(expected.manifestBytes), "EC_ADAPTER_ARTIFACT_CONFLICT", "existing derived artifact manifest differs");
  for (const [relativePath, bytes] of expected.files) {
    const actual = fs.readFileSync(path.join(root, ...relativePath.split("/")));
    fail(actual.equals(bytes), "EC_ADAPTER_ARTIFACT_CONFLICT", `existing derived file ${relativePath} differs`);
  }
}

export function prepareProviderArtifact({ request, manifest }) {
  const configuration = validatePrepareConfiguration(request);
  const canonical = validateCanonicalArtifact(request);
  fail(
    !pathsOverlap(configuration.derivedDirectory, canonical.root),
    "EC_ADAPTER_CONFIGURATION_INVALID",
    "derivedDirectory and canonical artifact directory must not overlap",
  );
  const expected = buildExpected(request, manifest, canonical, configuration);
  let idempotent = false;
  if (fs.existsSync(configuration.derivedDirectory)) {
    validateExisting(configuration.derivedDirectory, expected);
    idempotent = true;
  } else {
    const parent = path.dirname(configuration.derivedDirectory);
    const staged = fs.mkdtempSync(path.join(parent, ".edge-canon-derived-"));
    try {
      writeTree(staged, expected);
      fs.renameSync(staged, configuration.derivedDirectory);
    } catch (error) {
      fs.rmSync(staged, { recursive: true, force: true });
      if (fs.existsSync(configuration.derivedDirectory)) {
        validateExisting(configuration.derivedDirectory, expected);
        idempotent = true;
      } else {
        throw error;
      }
    }
  }
  return {
    canonicalArtifactSha256: request.canonicalArtifact.sha256,
    derivedArtifactPath: path.join(configuration.derivedDirectory, DERIVED_MANIFEST),
    derivedArtifactSha256: sha256(expected.manifestBytes),
    entrypoint: expected.entrypoint,
    idempotent,
  };
}

/**
 * Revalidate a prepared provider tree immediately before any remote mutation.
 * Deploy must not trust a digest returned by an earlier process: both the
 * canonical input and every derived byte may have changed in between.
 */
export function validatePreparedProviderArtifact({ request, manifest }) {
  const configuration = validatePrepareConfiguration(request);
  const canonical = validateCanonicalArtifact(request);
  fail(
    !pathsOverlap(configuration.derivedDirectory, canonical.root),
    "EC_ADAPTER_CONFIGURATION_INVALID",
    "derivedDirectory and canonical artifact directory must not overlap",
  );
  const expected = buildExpected(request, manifest, canonical, configuration);
  validateExisting(configuration.derivedDirectory, expected);
  return {
    canonicalArtifactSha256: request.canonicalArtifact.sha256,
    derivedArtifactPath: path.join(configuration.derivedDirectory, DERIVED_MANIFEST),
    derivedArtifactSha256: sha256(expected.manifestBytes),
    entrypoint: expected.entrypoint,
  };
}
