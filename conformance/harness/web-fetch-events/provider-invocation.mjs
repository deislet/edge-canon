import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sha256 } from "./canonical-artifact.mjs";
import {
  acquireOperationLock,
  deploymentStatePath,
  loadProviderDeployment,
  ProviderDeploymentError,
  validateDeploymentConfiguration,
} from "./provider-deployment.mjs";
import { validateHarnessConfiguration } from "./provider-artifact.mjs";

const STATE_FORMAT = "edge-canon.provider-invocation-state/v1";
const PLAN = [
  ["EC-WEB-T012", "cpu"],
  ["EC-WEB-T001", "sync"],
  ["EC-WEB-T002", "context"],
  ["EC-WEB-T002", "transport-headers"],
  ["EC-WEB-T003", "methods"],
  ["EC-WEB-T004", "throws"],
  ["EC-WEB-T005", "invalid-results"],
  ["EC-WEB-T006", "concurrent"],
  ["EC-WEB-T007", "stream"],
  ["EC-WEB-T008", "background"],
  ["EC-WEB-T009", "late-wait-until"],
  ["EC-WEB-T010", "disconnect"],
  ["EC-WEB-T011", "artifact-lineage"],
  ["EC-WEB-T013", "subrequests"],
  ["EC-WEB-T014", "connections"],
  ["EC-WEB-T015", "request-body-limit"],
].map(([caseId, stepId]) => Object.freeze({ caseId, stepId }));
const PLAN_SHA256 = sha256(Buffer.from(JSON.stringify(PLAN), "utf8"));
const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_STATE_BYTES = 1024 * 1024;
const CONTROL_PREFIX = "/__edge-canon/control";

export class ProviderInvocationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderInvocationError";
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (!condition) throw new ProviderInvocationError(code, message);
}

function exactKeys(value, keys, label) {
  fail(value && typeof value === "object" && !Array.isArray(value), "EC_ADAPTER_STATE_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  fail(JSON.stringify(actual) === JSON.stringify(expected), "EC_ADAPTER_STATE_INVALID", `${label} keys differ`);
}

function now() {
  return new Date().toISOString();
}

function syncDirectory(directory) {
  try {
    const descriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (!["EINVAL", "EISDIR", "EPERM", "ENOTSUP"].includes(error?.code)) throw error;
  }
}

function privateDirectory(directory, label) {
  const status = fs.lstatSync(directory, { throwIfNoEntry: false });
  fail(status?.isDirectory() && !status.isSymbolicLink(), "EC_ADAPTER_REQUEST_INVALID", `${label} is not a regular directory`);
  fail(fs.realpathSync(directory) === path.resolve(directory), "EC_ADAPTER_REQUEST_INVALID", `${label} traverses a symbolic link`);
  fs.chmodSync(directory, 0o700);
  return path.resolve(directory);
}

function writeJsonAtomic(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  fail(!existing || (existing.isFile() && !existing.isSymbolicLink()), "EC_ADAPTER_STATE_INVALID", "invocation state path is not a regular file");
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
    syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    }
    throw error;
  }
}

function readJsonFile(filePath, label) {
  const status = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!status) return null;
  fail(status.isFile() && !status.isSymbolicLink(), "EC_ADAPTER_STATE_INVALID", `${label} is not a regular file`);
  fail(status.size <= MAX_STATE_BYTES, "EC_ADAPTER_STATE_INVALID", `${label} is oversized`);
  fail(fs.realpathSync(filePath) === path.resolve(filePath), "EC_ADAPTER_STATE_INVALID", `${label} traverses a symbolic link`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new ProviderInvocationError("EC_ADAPTER_STATE_INVALID", `${label} is not readable JSON: ${error.message}`);
  }
}

function providerIdentitySha256(provider) {
  return sha256(Buffer.from(JSON.stringify(provider), "utf8"));
}

export function invocationStatePath(request, manifest) {
  return `${deploymentStatePath(request, manifest).slice(0, -5)}.invocation.json`;
}

function rawEvidencePath(request, manifest) {
  const evidence = privateDirectory(request.evidenceDirectory, "evidenceDirectory");
  const name = `${manifest.backendId}-${sha256(Buffer.from(`${manifest.backendId}\0${request.operationId}`, "utf8")).slice(0, 32)}-invoke.ndjson`;
  return path.join(evidence, name);
}

function initialState(request, manifest, deployment, artifact, evidencePath) {
  const timestamp = now();
  return {
    schemaVersion: 1,
    stateFormat: STATE_FORMAT,
    operationId: request.operationId,
    backendId: manifest.backendId,
    standardVersion: request.standardVersion,
    suiteId: request.suiteId,
    canonicalArtifactSha256: artifact.canonicalArtifactSha256,
    derivedArtifactSha256: artifact.derivedArtifactSha256,
    deploymentIdentitySha256: providerIdentitySha256(deployment.provider),
    planSha256: PLAN_SHA256,
    status: "invoking",
    currentStep: null,
    completedSteps: [],
    rawEvidenceFile: path.basename(evidencePath),
    rawEvidenceSha256: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function validateState(state, request, manifest, deployment, artifact, evidencePath) {
  exactKeys(state, [
    "schemaVersion", "stateFormat", "operationId", "backendId", "standardVersion", "suiteId",
    "canonicalArtifactSha256", "derivedArtifactSha256", "deploymentIdentitySha256", "planSha256",
    "status", "currentStep", "completedSteps", "rawEvidenceFile", "rawEvidenceSha256", "createdAt", "updatedAt",
  ], "invocation state");
  fail(state.schemaVersion === 1 && state.stateFormat === STATE_FORMAT, "EC_ADAPTER_STATE_INVALID", "invocation state format differs");
  fail(state.operationId === request.operationId && state.backendId === manifest.backendId, "EC_ADAPTER_STATE_INVALID", "invocation state identity differs");
  fail(state.standardVersion === request.standardVersion && state.suiteId === request.suiteId, "EC_ADAPTER_STATE_INVALID", "invocation state standard differs");
  fail(state.canonicalArtifactSha256 === artifact.canonicalArtifactSha256, "EC_ADAPTER_STATE_INVALID", "invocation canonical digest differs");
  fail(state.derivedArtifactSha256 === artifact.derivedArtifactSha256, "EC_ADAPTER_STATE_INVALID", "invocation derived digest differs");
  fail(state.deploymentIdentitySha256 === providerIdentitySha256(deployment.provider), "EC_ADAPTER_STATE_INVALID", "invocation deployment identity differs");
  fail(state.planSha256 === PLAN_SHA256, "EC_ADAPTER_STATE_INVALID", "invocation plan differs");
  fail(["invoking", "invoked", "invoke-indeterminate"].includes(state.status), "EC_ADAPTER_STATE_INVALID", "invocation state status is unknown");
  fail(state.currentStep === null || PLAN.some(({ stepId }) => stepId === state.currentStep), "EC_ADAPTER_STATE_INVALID", "invocation current step is invalid");
  fail(Array.isArray(state.completedSteps), "EC_ADAPTER_STATE_INVALID", "completedSteps is not an array");
  const known = PLAN.map(({ stepId }) => stepId);
  fail(state.completedSteps.every((step, index) => step === known[index]), "EC_ADAPTER_STATE_INVALID", "completedSteps is not a plan prefix");
  fail(state.rawEvidenceFile === path.basename(evidencePath), "EC_ADAPTER_STATE_INVALID", "invocation evidence filename differs");
  fail(state.rawEvidenceSha256 === null || /^[0-9a-f]{64}$/.test(state.rawEvidenceSha256), "EC_ADAPTER_STATE_INVALID", "invocation evidence digest is invalid");
  fail(Number.isFinite(Date.parse(state.createdAt)) && Number.isFinite(Date.parse(state.updatedAt)), "EC_ADAPTER_STATE_INVALID", "invocation state timestamp is invalid");
  if (state.status === "invoked") {
    const status = fs.lstatSync(evidencePath, { throwIfNoEntry: false });
    fail(status?.isFile() && !status.isSymbolicLink(), "EC_ADAPTER_STATE_INVALID", "completed invocation evidence is missing");
    fail(sha256(fs.readFileSync(evidencePath)) === state.rawEvidenceSha256, "EC_ADAPTER_STATE_INVALID", "completed invocation evidence digest differs");
  }
  return state;
}

function transition(filePath, state, changes) {
  const next = { ...state, ...changes, updatedAt: now() };
  writeJsonAtomic(filePath, next);
  return next;
}

function appendRecord(filePath, sequence, caseId, stepId, kind, data) {
  const record = {
    schemaVersion: 1,
    sequence,
    observedAt: now(),
    caseId,
    stepId,
    kind,
    data,
  };
  const descriptor = fs.openSync(filePath, "a", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(filePath, 0o600);
  return record;
}

function invocationId(operationId, caseId, variant = "default") {
  const value = `ecw-${sha256(Buffer.from(`${operationId}\0${caseId}\0${variant}`, "utf8")).slice(0, 40)}`;
  fail(INVOCATION_ID.test(value), "EC_ADAPTER_INTERNAL", "generated invocation identity is invalid");
  return value;
}

function deploymentBaseUrl(deployment) {
  fail(typeof deployment.provider.url === "string", "EC_ADAPTER_STATE_INVALID", "deployment has no invocation URL");
  let url;
  try {
    url = new URL(deployment.provider.url);
  } catch (error) {
    throw new ProviderInvocationError("EC_ADAPTER_STATE_INVALID", `deployment invocation URL is invalid: ${error.message}`);
  }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  fail(url.protocol === "https:" || loopback, "EC_ADAPTER_STATE_INVALID", "deployment invocation URL must use HTTPS or HTTP loopback");
  fail(!url.username && !url.password && !url.hash && !url.search, "EC_ADAPTER_STATE_INVALID", "deployment invocation URL contains unsafe components");
  return url;
}

function requestUrl(base, pathname) {
  fail(typeof pathname === "string" && pathname.startsWith("/"), "EC_ADAPTER_INTERNAL", "fixture pathname must be absolute");
  return new URL(pathname, base);
}

function transportHeaders(request, manifest, environment, caseId, variant, evidenceMode = "on") {
  const headers = {
    "x-edge-canon-invocation-id": invocationId(request.operationId, caseId, variant),
    "x-edge-canon-evidence-token": environment.EDGE_CANON_EVIDENCE_TOKEN,
  };
  if (evidenceMode === "off") headers["x-edge-canon-evidence-mode"] = "off";
  if (manifest.backendId === "deislet") {
    headers["x-deis-app-id"] = request.configuration.projectName;
    headers["x-deis-environment"] = request.configuration.environmentName;
  }
  return headers;
}

function selectedHeaders(headers) {
  const result = {};
  for (const name of ["cache-control", "content-encoding", "content-length", "content-type"]) {
    const value = headers.get(name);
    if (value !== null) result[name] = value.slice(0, 1024);
  }
  return result;
}

function deadlinePromise(deadlineAt, controller) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderInvocationError("EC_ADAPTER_REMOTE_RESULT_UNKNOWN", "provider exchange exceeded its total deadline"));
    }, Math.max(0, deadlineAt - Date.now()));
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function beforeDeadline(promise, deadlineAt, controller) {
  const deadline = deadlinePromise(deadlineAt, controller);
  promise.catch(() => undefined);
  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    deadline.cancel();
  }
}

async function readBody(response, maximumBytes, deadlineAt, controller) {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  fail(!Number.isFinite(declared) || declared <= maximumBytes, "EC_ADAPTER_REMOTE_OUTPUT_LIMIT", "provider response exceeds the evidence limit");
  if (!response.body) return { bytes: Buffer.alloc(0), fragments: [], terminalState: "no-body" };
  const reader = response.body.getReader();
  const chunks = [];
  const fragments = [];
  let size = 0;
  try {
    while (true) {
      const result = await beforeDeadline(reader.read(), deadlineAt, controller);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new ProviderInvocationError("EC_ADAPTER_REMOTE_OUTPUT_LIMIT", "provider response exceeds the evidence limit");
      }
      fragments.push(result.value.byteLength);
      chunks.push(Buffer.from(result.value));
    }
    return { bytes: Buffer.concat(chunks), fragments, terminalState: "closed" };
  } finally {
    reader.releaseLock();
  }
}

function requestSummary(method, pathname, body) {
  const bytes = body === undefined || body === null
    ? Buffer.alloc(0)
    : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  return {
    method,
    pathname,
    bodyByteLength: bytes.byteLength,
    bodySha256: sha256(bytes),
  };
}

async function httpExchange({
  base,
  pathname,
  method = "GET",
  body,
  headers = {},
  timeoutMs,
  maximumBytes,
  fetchImpl,
}) {
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  let response;
  try {
    response = await beforeDeadline(fetchImpl(requestUrl(base, pathname), {
      method,
      body,
      headers,
      redirect: "manual",
      signal: controller.signal,
    }), deadlineAt, controller);
    const result = await readBody(response, maximumBytes, deadlineAt, controller);
    return {
      request: requestSummary(method, pathname, body),
      response: {
        status: response.status,
        headers: selectedHeaders(response.headers),
        bodyBase64: result.bytes.toString("base64"),
        bodyByteLength: result.bytes.byteLength,
        bodySha256: sha256(result.bytes),
        readFragmentByteLengths: result.fragments,
        terminalState: result.terminalState,
      },
    };
  } catch (error) {
    controller.abort();
    if (error instanceof ProviderInvocationError) throw error;
    throw new ProviderInvocationError("EC_ADAPTER_REMOTE_RESULT_UNKNOWN", "provider exchange ended without a complete bounded response");
  }
}

async function disconnectExchange({ base, pathname, headers, timeoutMs, maximumBytes, fetchImpl }) {
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  try {
    const response = await beforeDeadline(fetchImpl(requestUrl(base, pathname), {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    }), deadlineAt, controller);
    fail(response.body, "EC_ADAPTER_REMOTE_RESULT_UNKNOWN", "disconnect fixture response has no body");
    const reader = response.body.getReader();
    const first = await beforeDeadline(reader.read(), deadlineAt, controller);
    fail(!first.done && first.value.byteLength <= maximumBytes, "EC_ADAPTER_REMOTE_RESULT_UNKNOWN", "disconnect fixture did not expose its first body part");
    await beforeDeadline(reader.cancel("edge-canon-client-disconnect"), deadlineAt, controller);
    reader.releaseLock();
    return {
      request: requestSummary("GET", pathname),
      response: {
        status: response.status,
        headers: selectedHeaders(response.headers),
        firstBodyPartBase64: Buffer.from(first.value).toString("base64"),
        firstBodyPartSha256: sha256(Buffer.from(first.value)),
        bodyTerminalState: "cancelled",
      },
    };
  } catch (error) {
    controller.abort();
    if (error instanceof ProviderInvocationError) throw error;
    throw new ProviderInvocationError("EC_ADAPTER_REMOTE_RESULT_UNKNOWN", "client disconnect could not be observed to completion");
  }
}

function controlUrl(origin, suffix) {
  const url = new URL(origin);
  url.pathname = `${CONTROL_PREFIX}/${suffix}`;
  url.search = "";
  url.hash = "";
  return url;
}

async function controlExchange(origin, suffix, token, fetchImpl, timeoutMs, method = "GET") {
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  try {
    const response = await beforeDeadline(fetchImpl(controlUrl(origin, suffix), {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    }), deadlineAt, controller);
    fail(response.ok, "EC_ADAPTER_HARNESS_SERVICE_FAILED", `controlled harness service returned HTTP ${response.status}`);
    const result = await readBody(response, 64 * 1024, deadlineAt, controller);
    try {
      return JSON.parse(result.bytes.toString("utf8"));
    } catch {
      throw new ProviderInvocationError("EC_ADAPTER_HARNESS_SERVICE_FAILED", "controlled harness service returned invalid JSON");
    }
  } catch (error) {
    controller.abort();
    if (error instanceof ProviderInvocationError) throw error;
    throw new ProviderInvocationError("EC_ADAPTER_HARNESS_SERVICE_FAILED", "controlled harness service request failed");
  }
}

async function assertEvidenceSinkEmpty(url, token, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  try {
    const response = await beforeDeadline(fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    }), deadlineAt, controller);
    fail(response.ok, "EC_ADAPTER_HARNESS_SERVICE_FAILED", `evidence sink returned HTTP ${response.status}`);
    const result = await readBody(response, 64 * 1024, deadlineAt, controller);
    let document;
    try {
      document = JSON.parse(result.bytes.toString("utf8"));
    } catch {
      throw new ProviderInvocationError("EC_ADAPTER_HARNESS_SERVICE_FAILED", "evidence sink returned invalid JSON");
    }
    fail(document?.schemaVersion === 1 && Array.isArray(document.records), "EC_ADAPTER_HARNESS_SERVICE_FAILED", "evidence sink response shape differs");
    fail(document.records.length === 0, "EC_ADAPTER_EVIDENCE_CONFLICT", "operation evidence sink is not empty before invocation");
  } catch (error) {
    controller.abort();
    if (error instanceof ProviderInvocationError) throw error;
    throw new ProviderInvocationError("EC_ADAPTER_HARNESS_SERVICE_FAILED", "evidence sink query failed");
  }
}

function validSlots(value, label) {
  fail(Array.isArray(value), "EC_ADAPTER_HARNESS_SERVICE_FAILED", `${label} is not an array`);
  fail(value.every((slot) => Number.isSafeInteger(slot) && slot >= 0 && slot <= 6), "EC_ADAPTER_HARNESS_SERVICE_FAILED", `${label} contains an invalid slot`);
  fail(new Set(value).size === value.length, "EC_ADAPTER_HARNESS_SERVICE_FAILED", `${label} contains a duplicate slot`);
  return value;
}

function textBody(exchange) {
  return Buffer.from(exchange.response.bodyBase64, "base64").toString("utf8");
}

async function invokeStep(step, context) {
  const { request, manifest, environment, base, timeoutMs, maximumBytes, fetchImpl } = context;
  const headers = (variant, evidenceMode = "on") => transportHeaders(request, manifest, environment, step.caseId, variant, evidenceMode);
  const exchange = (pathname, options = {}) => httpExchange({
    base,
    pathname,
    timeoutMs,
    maximumBytes,
    fetchImpl,
    ...options,
  });

  switch (step.stepId) {
    case "cpu":
      return { exchange: await exchange("/cpu", { headers: headers("cpu", "off") }) };
    case "sync":
      return { exchange: await exchange("/sync", { headers: headers("sync") }) };
    case "context":
      return { exchange: await exchange("/context", { headers: headers("context") }) };
    case "transport-headers":
      return { exchange: await exchange("/transport-headers", { headers: headers("transport") }) };
    case "methods": {
      const inputs = [["GET", ""], ["POST", "post-body"], ["PURGE", "purge-body"]];
      const exchanges = [];
      for (const [method, body] of inputs) {
        exchanges.push(await exchange("/method", {
          method,
          body: body || undefined,
          headers: headers(method.toLowerCase()),
        }));
      }
      return { exchanges };
    }
    case "throws":
      return {
        exchanges: [
          await exchange("/throw-sync", { headers: headers("sync") }),
          await exchange("/throw-async", { headers: headers("async") }),
        ],
      };
    case "invalid-results": {
      const variants = ["undefined", "string", "object"];
      const exchanges = [];
      for (const variant of variants) {
        exchanges.push(await exchange(`/invalid-${variant}`, { headers: headers(variant) }));
      }
      return { exchanges };
    }
    case "concurrent": {
      const completionOrder = [];
      const promises = Array.from({ length: 8 }, (_, index) => {
        const marker = `request-${index}`;
        const pathname = `/concurrent?marker=${marker}&delay=${(7 - index) * 5}`;
        return exchange(pathname, { headers: headers(marker) }).then((value) => {
          completionOrder.push(marker);
          return { marker, exchange: value };
        });
      });
      return { completionOrder, exchanges: await Promise.all(promises) };
    }
    case "stream":
      return { exchange: await exchange("/stream", { headers: headers("stream") }) };
    case "background":
      return { exchange: await exchange("/background", { headers: headers("background") }) };
    case "late-wait-until":
      return { exchange: await exchange("/capture-wait-until", { headers: headers("capture") }) };
    case "disconnect": {
      const marker = "disconnect-one";
      const disconnected = await disconnectExchange({
        base,
        pathname: `/disconnect?marker=${marker}`,
        headers: headers("disconnect"),
        timeoutMs,
        maximumBytes,
        fetchImpl,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const probe = await exchange("/probe?marker=probe-two", { headers: headers("probe") });
      return { marker, disconnected, probe };
    }
    case "artifact-lineage":
      return {
        canonicalArtifactSha256: context.artifact.canonicalArtifactSha256,
        derivedArtifactSha256: context.artifact.derivedArtifactSha256,
        deploymentIdentitySha256: providerIdentitySha256(context.deployment.provider),
        pinnedStandardVersion: request.standardVersion,
      };
    case "subrequests": {
      const origin = request.configuration.controlledOriginUrl;
      await controlExchange(origin, "origin/reset", environment.EDGE_CANON_EVIDENCE_TOKEN, fetchImpl, timeoutMs, "POST");
      const worker = await exchange("/subrequests", { headers: headers("subrequests", "off") });
      const originStatus = await controlExchange(origin, "origin/status", environment.EDGE_CANON_EVIDENCE_TOKEN, fetchImpl, timeoutMs);
      fail(Number.isSafeInteger(originStatus.totalRequestCount), "EC_ADAPTER_HARNESS_SERVICE_FAILED", "controlled origin status has no request count");
      return { worker, originStatus };
    }
    case "connections": {
      const origin = request.configuration.connectionBarrierOriginUrl;
      await controlExchange(origin, "barrier/reset", environment.EDGE_CANON_EVIDENCE_TOKEN, fetchImpl, timeoutMs, "POST");
      const workerPromise = exchange("/connections", { headers: headers("connections", "off") });
      workerPromise.catch(() => undefined);
      const pollingDeadline = Date.now() + Math.min(timeoutMs, 30_000);
      let beforeRelease;
      while (Date.now() < pollingDeadline) {
        const status = await controlExchange(origin, "barrier/status", environment.EDGE_CANON_EVIDENCE_TOKEN, fetchImpl, Math.min(timeoutMs, 5_000));
        const waitingSlots = validSlots(status.waitingSlots, "barrier waitingSlots");
        const startedSlots = validSlots(status.startedSlots, "barrier startedSlots");
        const cancelledSlots = validSlots(status.cancelledSlots ?? [], "barrier cancelledSlots");
        if (waitingSlots.length >= 6) {
          beforeRelease = { waitingSlots, startedSlots, cancelledSlots };
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      fail(beforeRelease, "EC_ADAPTER_HARNESS_SERVICE_FAILED", "connection barrier did not observe six waiting connections");
      const release = await controlExchange(origin, "barrier/release", environment.EDGE_CANON_EVIDENCE_TOKEN, fetchImpl, timeoutMs, "POST");
      return { beforeRelease, release, worker: await workerPromise };
    }
    case "request-body-limit": {
      const body = Buffer.allocUnsafe(1_000_000);
      for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
      return {
        requestBodySha256: sha256(body),
        exchange: await exchange("/request-body-limit", {
          method: "POST",
          body,
          headers: {
            ...headers("request-body"),
            "content-length": String(body.byteLength),
            "content-type": "application/octet-stream",
          },
        }),
      };
    }
    default:
      throw new ProviderInvocationError("EC_ADAPTER_INTERNAL", `unknown invocation step ${step.stepId}`);
  }
}

function evidenceReference(evidencePath, digest) {
  return `evidence:${path.basename(evidencePath)}:sha256:${digest}`;
}

function outcome(request, manifest, statePath, state, evidencePath, result, failure = null, mutatedRemoteState = true) {
  const evidenceRefs = state.rawEvidenceSha256 ? [evidenceReference(evidencePath, state.rawEvidenceSha256)] : [];
  return {
    schemaVersion: 1,
    protocolVersion: manifest.protocolVersion,
    operation: request.operation,
    operationId: request.operationId,
    backendId: manifest.backendId,
    outcome: result,
    mutatedRemoteState,
    retrySafe: result !== "indeterminate",
    data: { statePath, state },
    evidenceRefs,
    failure,
  };
}

export async function invokeProvider({ request, manifest, environment, fetchImpl = fetch }) {
  validateDeploymentConfiguration(request, manifest);
  validateHarnessConfiguration(request.configuration);
  const deploymentPath = deploymentStatePath(request, manifest);
  const releaseLock = acquireOperationLock(deploymentPath);
  try {
    const { artifact, state: deployment } = loadProviderDeployment({ request, manifest });
    fail(deployment.status === "deployed", "EC_ADAPTER_STATE_INVALID", "invoke requires a verified deployed provider identity");
    const base = deploymentBaseUrl(deployment);
    const statePath = invocationStatePath(request, manifest);
    const evidencePath = rawEvidencePath(request, manifest);
    let state = readJsonFile(statePath, "invocation state");
    if (state) state = validateState(state, request, manifest, deployment, artifact, evidencePath);
    if (state?.status === "invoked") return outcome(request, manifest, statePath, state, evidencePath, "succeeded", null, false);
    if (state) {
      if (state.status === "invoking") {
        state = transition(statePath, state, {
          status: "invoke-indeterminate",
          rawEvidenceSha256: fs.existsSync(evidencePath) ? sha256(fs.readFileSync(evidencePath)) : sha256(Buffer.alloc(0)),
        });
      }
      return outcome(
        request,
        manifest,
        statePath,
        state,
        evidencePath,
        "indeterminate",
        { code: "EC_ADAPTER_REMOTE_RECONCILIATION_REQUIRED", message: "a prior invocation attempt lacks a verified terminal result; handler requests were not repeated" },
        false,
      );
    }

    await assertEvidenceSinkEmpty(
      request.configuration.evidenceSinkUrl,
      environment.EDGE_CANON_EVIDENCE_TOKEN,
      fetchImpl,
      Math.min(manifest.security.timeoutSeconds * 1_000, 30_000),
    );

    const evidenceStatus = fs.lstatSync(evidencePath, { throwIfNoEntry: false });
    fail(!evidenceStatus, "EC_ADAPTER_EVIDENCE_CONFLICT", "invocation evidence exists without its bound state");
    fs.writeFileSync(evidencePath, "", { flag: "wx", mode: 0o600 });
    fs.chmodSync(evidencePath, 0o600);
    syncDirectory(path.dirname(evidencePath));
    state = initialState(request, manifest, deployment, artifact, evidencePath);
    writeJsonAtomic(statePath, state);

    const context = {
      request,
      manifest,
      environment,
      deployment,
      artifact,
      base,
      timeoutMs: manifest.security.timeoutSeconds * 1_000,
      maximumBytes: manifest.security.maxOutputBytes,
      fetchImpl,
    };
    let sequence = 0;
    for (const step of PLAN) {
      state = transition(statePath, state, { currentStep: step.stepId });
      try {
        const data = await invokeStep(step, context);
        appendRecord(evidencePath, sequence, step.caseId, step.stepId, "step-completed", data);
        sequence += 1;
        state = transition(statePath, state, {
          currentStep: null,
          completedSteps: [...state.completedSteps, step.stepId],
        });
      } catch (error) {
        appendRecord(evidencePath, sequence, step.caseId, step.stepId, "step-indeterminate", {
          failureCode: error instanceof ProviderInvocationError || error instanceof ProviderDeploymentError
            ? error.code
            : "EC_ADAPTER_REMOTE_RESULT_UNKNOWN",
        });
        const digest = sha256(fs.readFileSync(evidencePath));
        state = transition(statePath, state, { status: "invoke-indeterminate", rawEvidenceSha256: digest });
        return outcome(
          request,
          manifest,
          statePath,
          state,
          evidencePath,
          "indeterminate",
          {
            code: error instanceof ProviderInvocationError || error instanceof ProviderDeploymentError
              ? error.code
              : "EC_ADAPTER_REMOTE_RESULT_UNKNOWN",
            message: `invocation step ${step.stepId} ended without a complete observation; it will not be repeated`,
          },
        );
      }
    }
    const digest = sha256(fs.readFileSync(evidencePath));
    state = transition(statePath, state, { status: "invoked", rawEvidenceSha256: digest });
    return outcome(request, manifest, statePath, state, evidencePath, "succeeded");
  } finally {
    releaseLock();
  }
}

export const invocationPlan = Object.freeze(PLAN.map((step) => ({ ...step })));
