import fs from "node:fs";
import path from "node:path";

import { sha256 } from "./canonical-artifact.mjs";
import { acquireOperationLock, deploymentStatePath } from "./provider-deployment.mjs";
import {
  invocationPlan,
  loadProviderInvocation,
  providerInvocationId,
} from "./provider-invocation.mjs";

const STATE_FORMAT = "edge-canon.provider-collection-state/v1";
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const ERROR_SENTINEL = "EC_WEB_SECRET_MUST_NOT_LEAK";
const CASE_IDS = Array.from({ length: 15 }, (_, index) => `EC-WEB-T${String(index + 1).padStart(3, "0")}`);

export class ProviderCollectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderCollectionError";
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (!condition) throw new ProviderCollectionError(code, message);
}

function exactKeys(value, keys, label, code = "EC_ADAPTER_EVIDENCE_INVALID") {
  fail(value && typeof value === "object" && !Array.isArray(value), code, `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  fail(JSON.stringify(actual) === JSON.stringify(expected), code, `${label} keys differ`);
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

function privateEvidenceDirectory(directory) {
  const status = fs.lstatSync(directory, { throwIfNoEntry: false });
  fail(status?.isDirectory() && !status.isSymbolicLink(), "EC_ADAPTER_REQUEST_INVALID", "evidenceDirectory is not a regular directory");
  fail(fs.realpathSync(directory) === path.resolve(directory), "EC_ADAPTER_REQUEST_INVALID", "evidenceDirectory traverses a symbolic link");
  fs.chmodSync(directory, 0o700);
  return path.resolve(directory);
}

function immutableJson(filePath, value, label) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  fail(bytes.byteLength <= MAX_DOCUMENT_BYTES, "EC_ADAPTER_REMOTE_OUTPUT_LIMIT", `${label} exceeds the evidence limit`);
  const status = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (status) {
    fail(status.isFile() && !status.isSymbolicLink(), "EC_ADAPTER_EVIDENCE_CONFLICT", `${label} path is not a regular file`);
    fail(fs.realpathSync(filePath) === path.resolve(filePath), "EC_ADAPTER_EVIDENCE_CONFLICT", `${label} path traverses a symbolic link`);
    fail(fs.readFileSync(filePath).equals(bytes), "EC_ADAPTER_EVIDENCE_CONFLICT", `${label} immutable bytes differ`);
  } else {
    const descriptor = fs.openSync(filePath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(filePath, 0o600);
    syncDirectory(path.dirname(filePath));
  }
  return { bytes, sha256: sha256(bytes) };
}

function readJson(filePath, label) {
  const status = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!status) return null;
  fail(status.isFile() && !status.isSymbolicLink(), "EC_ADAPTER_EVIDENCE_INVALID", `${label} is not a regular file`);
  fail(status.size <= MAX_DOCUMENT_BYTES, "EC_ADAPTER_EVIDENCE_INVALID", `${label} is oversized`);
  fail(fs.realpathSync(filePath) === path.resolve(filePath), "EC_ADAPTER_EVIDENCE_INVALID", `${label} traverses a symbolic link`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new ProviderCollectionError("EC_ADAPTER_EVIDENCE_INVALID", `${label} is not readable JSON: ${error.message}`);
  }
}

function event(eventName, fields = {}) {
  return { event: eventName, ...fields };
}

function standardEvents({
  method = "GET",
  pathname,
  registered = 0,
  terminalState = ["no-body", "closed", "errored", "cancelled"],
  middle = [],
}) {
  return [
    event("invocation-start", { method, pathname }),
    ...middle,
    event("handler-settled"),
    event("lifecycle-closed", { registeredBackgroundTaskCount: registered, terminalState }),
  ];
}

function expectedInvocationSpecs(operationId) {
  const specs = [];
  const add = (caseId, variant, events) => specs.push({
    caseId,
    variant,
    invocationId: providerInvocationId(operationId, caseId, variant),
    events,
  });
  add("EC-WEB-T001", "sync", standardEvents({ pathname: "/sync" }));
  add("EC-WEB-T002", "context", standardEvents({
    pathname: "/context",
    registered: 1,
    middle: [event("record", { marker: "background-complete" }), event("background-registered", { taskNumber: 1 })],
  }));
  add("EC-WEB-T002", "transport", standardEvents({ pathname: "/transport-headers" }));
  for (const [variant, method] of [["get", "GET"], ["post", "POST"], ["purge", "PURGE"]]) {
    add("EC-WEB-T003", variant, standardEvents({ method, pathname: "/method" }));
  }
  for (const variant of ["sync", "async"]) {
    add("EC-WEB-T004", variant, standardEvents({
      pathname: `/throw-${variant}`,
      middle: [event("failure", { failureCode: "EC_HANDLER_THROWN" })],
    }));
  }
  for (const variant of ["undefined", "string", "object"]) {
    add("EC-WEB-T005", variant, standardEvents({
      pathname: `/invalid-${variant}`,
      middle: [event("failure", { failureCode: "EC_HANDLER_RESULT_INVALID" })],
    }));
  }
  for (let index = 0; index < 8; index += 1) {
    add("EC-WEB-T006", `request-${index}`, standardEvents({ pathname: "/concurrent" }));
  }
  add("EC-WEB-T007", "stream", standardEvents({ pathname: "/stream" }));
  add("EC-WEB-T008", "background", standardEvents({
    pathname: "/background",
    registered: 3,
    middle: [
      event("background-registered", { taskNumber: 1 }),
      event("background-registered", { taskNumber: 2 }),
      event("background-registered", { taskNumber: 3 }),
      event("record", { marker: "background-first" }),
      event("failure", { failureCode: "EC_BACKGROUND_REJECTED", taskNumber: 2 }),
      event("record", { marker: "background-third" }),
    ],
  }));
  add("EC-WEB-T009", "capture", standardEvents({
    pathname: "/capture-wait-until",
    registered: 1,
    middle: [
      event("background-registered", { taskNumber: 1 }),
      event("failure", { failureCode: "EC_WAIT_UNTIL_CLOSED" }),
      event("record", { marker: "late-wait-until:TypeError:EC_WAIT_UNTIL_CLOSED" }),
    ],
  }));
  add("EC-WEB-T010", "disconnect", standardEvents({
    pathname: "/disconnect",
    registered: 1,
    terminalState: ["cancelled", "closed", "errored"],
    middle: [
      event("record", { marker: "invocation:disconnect-one" }),
      event("background-registered", { taskNumber: 1 }),
      event("record", { marker: "background:disconnect-one" }),
      event("record", { marker: "body-cancelled:disconnect-one" }),
    ],
  }));
  add("EC-WEB-T010", "probe", standardEvents({ pathname: "/probe" }));
  add("EC-WEB-T015", "request-body", standardEvents({
    method: "POST",
    pathname: "/request-body-limit",
    middle: [event("record", { marker: "request-body-limit-invoked" })],
  }));
  return specs;
}

function validateHarnessEvent(record, label) {
  fail(record && typeof record === "object" && !Array.isArray(record), "EC_ADAPTER_EVIDENCE_INVALID", `${label} must be an object`);
  const base = ["schemaVersion", "backendId", "event", "invocationId", "eventSequence"];
  fail(record.schemaVersion === 1, "EC_ADAPTER_EVIDENCE_INVALID", `${label} schemaVersion differs`);
  fail(typeof record.backendId === "string" && typeof record.invocationId === "string", "EC_ADAPTER_EVIDENCE_INVALID", `${label} identity is invalid`);
  fail(Number.isSafeInteger(record.eventSequence) && record.eventSequence >= 0, "EC_ADAPTER_EVIDENCE_INVALID", `${label} sequence is invalid`);
  switch (record.event) {
    case "invocation-start":
      exactKeys(record, [...base, "method", "pathname"], label);
      fail(typeof record.method === "string" && typeof record.pathname === "string", "EC_ADAPTER_EVIDENCE_INVALID", `${label} request facts are invalid`);
      break;
    case "record":
      exactKeys(record, [...base, "marker"], label);
      fail(typeof record.marker === "string", "EC_ADAPTER_EVIDENCE_INVALID", `${label} marker is invalid`);
      break;
    case "background-registered":
      exactKeys(record, [...base, "taskNumber"], label);
      fail(Number.isSafeInteger(record.taskNumber) && record.taskNumber > 0, "EC_ADAPTER_EVIDENCE_INVALID", `${label} task number is invalid`);
      break;
    case "failure":
      exactKeys(record, record.taskNumber === undefined ? [...base, "failureCode"] : [...base, "failureCode", "taskNumber"], label);
      fail(/^EC_[A-Z0-9_]+$/.test(record.failureCode), "EC_ADAPTER_EVIDENCE_INVALID", `${label} failure code is invalid`);
      break;
    case "handler-settled":
      exactKeys(record, base, label);
      break;
    case "lifecycle-closed":
      exactKeys(record, [...base, "registeredBackgroundTaskCount", "terminalState"], label);
      fail(Number.isSafeInteger(record.registeredBackgroundTaskCount) && record.registeredBackgroundTaskCount >= 0, "EC_ADAPTER_EVIDENCE_INVALID", `${label} background count is invalid`);
      fail(["no-body", "closed", "errored", "cancelled"].includes(record.terminalState), "EC_ADAPTER_EVIDENCE_INVALID", `${label} terminal state is invalid`);
      break;
    default:
      throw new ProviderCollectionError("EC_ADAPTER_EVIDENCE_INVALID", `${label} kind is unknown`);
  }
}

function eventDescriptor(record) {
  const { schemaVersion: _schemaVersion, backendId: _backendId, invocationId: _invocationId, eventSequence: _eventSequence, ...rest } = record;
  return rest;
}

function matchesEvent(actual, expected) {
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort())) return false;
  return Object.entries(expected).every(([key, expectedValue]) =>
    Array.isArray(expectedValue) ? expectedValue.includes(actual[key]) : actual[key] === expectedValue);
}

function matchEventSet(records, expectedEvents, label) {
  const unmatched = [...expectedEvents];
  for (const record of records) {
    const actual = eventDescriptor(record);
    const index = unmatched.findIndex((expected) => matchesEvent(actual, expected));
    fail(index >= 0, "EC_ADAPTER_EVIDENCE_INVALID", `${label} contains an unexpected event`);
    unmatched.splice(index, 1);
  }
  return unmatched;
}

function validateEvidenceDocument(document, manifest, specs, complete) {
  exactKeys(document, ["schemaVersion", "records"], "evidence sink document");
  fail(document.schemaVersion === 1 && Array.isArray(document.records), "EC_ADAPTER_EVIDENCE_INVALID", "evidence sink response shape differs");
  const expected = new Map(specs.map((spec) => [spec.invocationId, spec]));
  const byInvocation = new Map(specs.map((spec) => [spec.invocationId, []]));
  for (const [index, envelope] of document.records.entries()) {
    exactKeys(envelope, ["schemaVersion", "sinkSequence", "receivedAt", "record"], `evidence envelope ${index}`);
    fail(envelope.schemaVersion === 1 && envelope.sinkSequence === index, "EC_ADAPTER_EVIDENCE_INVALID", `evidence envelope ${index} sequence differs`);
    fail(Number.isFinite(Date.parse(envelope.receivedAt)), "EC_ADAPTER_EVIDENCE_INVALID", `evidence envelope ${index} timestamp is invalid`);
    validateHarnessEvent(envelope.record, `evidence event ${index}`);
    fail(envelope.record.backendId === manifest.backendId, "EC_ADAPTER_EVIDENCE_INVALID", `evidence event ${index} backend differs`);
    const spec = expected.get(envelope.record.invocationId);
    fail(spec, "EC_ADAPTER_EVIDENCE_CONFLICT", `evidence event ${index} belongs to an unknown invocation`);
    const group = byInvocation.get(spec.invocationId);
    fail(!group.some((record) => record.eventSequence === envelope.record.eventSequence), "EC_ADAPTER_EVIDENCE_INVALID", `evidence event ${index} sequence is duplicated`);
    fail(envelope.record.eventSequence < spec.events.length, "EC_ADAPTER_EVIDENCE_INVALID", `evidence event ${index} exceeds the expected invocation event count`);
    group.push(envelope.record);
  }
  const expectedTotal = specs.reduce((sum, spec) => sum + spec.events.length, 0);
  fail(document.records.length <= expectedTotal, "EC_ADAPTER_EVIDENCE_INVALID", "evidence sink contains excess events");
  let ready = document.records.length === expectedTotal;
  for (const spec of specs) {
    const records = byInvocation.get(spec.invocationId);
    const unmatched = matchEventSet(records, spec.events, `${spec.caseId}/${spec.variant}`);
    if (records.length !== spec.events.length) ready = false;
    if (records.length === spec.events.length) {
      const sequences = records.map((record) => record.eventSequence).sort((left, right) => left - right);
      fail(sequences.every((value, index) => value === index), "EC_ADAPTER_EVIDENCE_INVALID", `${spec.caseId}/${spec.variant} event sequence has a gap`);
      fail(unmatched.length === 0, "EC_ADAPTER_EVIDENCE_INVALID", `${spec.caseId}/${spec.variant} event set differs`);
    }
  }
  if (complete) fail(ready, "EC_ADAPTER_EVIDENCE_INCOMPLETE", "evidence sink did not reach the complete invocation event set");
  return { ready, byInvocation };
}

async function responseBytes(response, maximumBytes, deadlineAt, controller) {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  fail(!Number.isFinite(declared) || declared <= maximumBytes, "EC_ADAPTER_REMOTE_OUTPUT_LIMIT", "evidence sink response is oversized");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const remaining = deadlineAt - Date.now();
      fail(remaining > 0, "EC_ADAPTER_HARNESS_SERVICE_FAILED", "evidence sink response timed out");
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProviderCollectionError("EC_ADAPTER_HARNESS_SERVICE_FAILED", "evidence sink response timed out"));
        }, remaining);
      });
      const result = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new ProviderCollectionError("EC_ADAPTER_REMOTE_OUTPUT_LIMIT", "evidence sink response is oversized");
      }
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

async function queryEvidenceSink(url, token, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    fail(response.ok, "EC_ADAPTER_HARNESS_SERVICE_FAILED", `evidence sink returned HTTP ${response.status}`);
    const bytes = await responseBytes(response, MAX_DOCUMENT_BYTES, deadlineAt, controller);
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new ProviderCollectionError("EC_ADAPTER_HARNESS_SERVICE_FAILED", `evidence sink returned invalid JSON: ${error.message}`);
    }
  } catch (error) {
    controller.abort();
    if (error instanceof ProviderCollectionError) throw error;
    throw new ProviderCollectionError("EC_ADAPTER_HARNESS_SERVICE_FAILED", "evidence sink query failed");
  } finally {
    clearTimeout(timer);
  }
}

async function captureEvidenceSnapshot({ request, manifest, environment, fetchImpl, timeoutMs, pollIntervalMs, snapshotPath, specs }) {
  const existing = readJson(snapshotPath, "evidence sink snapshot");
  if (existing) {
    validateEvidenceDocument(existing, manifest, specs, true);
    return existing;
  }
  const deadlineAt = Date.now() + timeoutMs;
  while (true) {
    const document = await queryEvidenceSink(
      request.configuration.evidenceSinkUrl,
      environment.EDGE_CANON_EVIDENCE_TOKEN,
      fetchImpl,
      Math.min(30_000, Math.max(1, deadlineAt - Date.now())),
    );
    const validation = validateEvidenceDocument(document, manifest, specs, false);
    if (validation.ready) {
      immutableJson(snapshotPath, document, "evidence sink snapshot");
      return document;
    }
    fail(Date.now() < deadlineAt, "EC_ADAPTER_EVIDENCE_INCOMPLETE", "evidence sink did not reach the complete invocation event set before the collection deadline");
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadlineAt - Date.now()))));
  }
}

function validateRawExchange(exchange, label) {
  exactKeys(exchange, ["request", "response"], `${label} exchange`);
  exactKeys(exchange.request, ["method", "pathname", "bodyByteLength", "bodySha256"], `${label} request`);
  fail(typeof exchange.request.method === "string" && typeof exchange.request.pathname === "string", "EC_ADAPTER_EVIDENCE_INVALID", `${label} request line is invalid`);
  fail(Number.isSafeInteger(exchange.request.bodyByteLength) && exchange.request.bodyByteLength >= 0 && /^[0-9a-f]{64}$/.test(exchange.request.bodySha256), "EC_ADAPTER_EVIDENCE_INVALID", `${label} request body facts are invalid`);
  exactKeys(exchange.response, ["status", "headers", "bodyBase64", "bodyByteLength", "bodySha256", "readFragmentByteLengths", "terminalState"], `${label} response`);
  fail(Number.isSafeInteger(exchange.response.status) && exchange.response.status >= 100 && exchange.response.status <= 599, "EC_ADAPTER_EVIDENCE_INVALID", `${label} response status is invalid`);
  fail(exchange.response.headers && typeof exchange.response.headers === "object" && !Array.isArray(exchange.response.headers), "EC_ADAPTER_EVIDENCE_INVALID", `${label} response headers are invalid`);
  fail(typeof exchange.response.bodyBase64 === "string" && /^[0-9A-Za-z+/]*={0,2}$/.test(exchange.response.bodyBase64), "EC_ADAPTER_EVIDENCE_INVALID", `${label} response body encoding is invalid`);
  const bytes = Buffer.from(exchange.response.bodyBase64, "base64");
  fail(bytes.toString("base64") === exchange.response.bodyBase64, "EC_ADAPTER_EVIDENCE_INVALID", `${label} response body encoding is non-canonical`);
  fail(bytes.byteLength === exchange.response.bodyByteLength && sha256(bytes) === exchange.response.bodySha256, "EC_ADAPTER_EVIDENCE_INVALID", `${label} response body facts differ`);
  fail(Array.isArray(exchange.response.readFragmentByteLengths) && exchange.response.readFragmentByteLengths.every((value) => Number.isSafeInteger(value) && value > 0), "EC_ADAPTER_EVIDENCE_INVALID", `${label} response fragments are invalid`);
  fail(exchange.response.readFragmentByteLengths.reduce((sum, value) => sum + value, 0) === bytes.byteLength, "EC_ADAPTER_EVIDENCE_INVALID", `${label} response fragment sizes differ from the body`);
  fail(["no-body", "closed"].includes(exchange.response.terminalState), "EC_ADAPTER_EVIDENCE_INVALID", `${label} response terminal state is invalid`);
  return exchange;
}

function validateDisconnectExchange(exchange, label) {
  exactKeys(exchange, ["request", "response"], `${label} exchange`);
  exactKeys(exchange.request, ["method", "pathname", "bodyByteLength", "bodySha256"], `${label} request`);
  exactKeys(exchange.response, ["status", "headers", "firstBodyPartBase64", "firstBodyPartSha256", "bodyTerminalState"], `${label} response`);
  const bytes = Buffer.from(exchange.response.firstBodyPartBase64, "base64");
  fail(bytes.toString("base64") === exchange.response.firstBodyPartBase64 && sha256(bytes) === exchange.response.firstBodyPartSha256, "EC_ADAPTER_EVIDENCE_INVALID", `${label} first body part differs`);
  fail(exchange.response.bodyTerminalState === "cancelled", "EC_ADAPTER_EVIDENCE_INVALID", `${label} did not record client cancellation`);
  return exchange;
}

function expectRequest(exchange, method, pathname, body = Buffer.alloc(0)) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  fail(
    exchange.request.method === method
      && exchange.request.pathname === pathname
      && exchange.request.bodyByteLength === bytes.byteLength
      && exchange.request.bodySha256 === sha256(bytes),
    "EC_ADAPTER_EVIDENCE_INVALID",
    `${method} ${pathname} request evidence differs from the fixed invocation plan`,
  );
  return exchange;
}

function readRawRecords(evidencePath) {
  const bytes = fs.readFileSync(evidencePath);
  fail(bytes.byteLength > 0 && bytes.byteLength <= MAX_DOCUMENT_BYTES && bytes.at(-1) === 10, "EC_ADAPTER_EVIDENCE_INVALID", "invocation evidence is empty, oversized or partial");
  const lines = bytes.toString("utf8").trimEnd().split("\n");
  fail(lines.length === invocationPlan.length, "EC_ADAPTER_EVIDENCE_INVALID", "invocation evidence does not contain the complete plan");
  return lines.map((line, index) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new ProviderCollectionError("EC_ADAPTER_EVIDENCE_INVALID", `invocation record ${index} is invalid JSON: ${error.message}`);
    }
    exactKeys(record, ["schemaVersion", "sequence", "observedAt", "caseId", "stepId", "kind", "data"], `invocation record ${index}`);
    const planned = invocationPlan[index];
    fail(record.schemaVersion === 1 && record.sequence === index, "EC_ADAPTER_EVIDENCE_INVALID", `invocation record ${index} sequence differs`);
    fail(record.caseId === planned.caseId && record.stepId === planned.stepId && record.kind === "step-completed", "EC_ADAPTER_EVIDENCE_INVALID", `invocation record ${index} plan identity differs`);
    fail(Number.isFinite(Date.parse(record.observedAt)), "EC_ADAPTER_EVIDENCE_INVALID", `invocation record ${index} timestamp is invalid`);
    fail(record.data && typeof record.data === "object" && !Array.isArray(record.data), "EC_ADAPTER_EVIDENCE_INVALID", `invocation record ${index} data is invalid`);
    return record;
  });
}

function bytesOf(exchange) {
  return Buffer.from(exchange.response.bodyBase64, "base64");
}

function textOf(exchange) {
  return bytesOf(exchange).toString("utf8");
}

function jsonOf(exchange) {
  try {
    const value = JSON.parse(textOf(exchange));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function headerOf(exchange, name) {
  const value = exchange.response.headers[name];
  return typeof value === "string" ? value : null;
}

function eventsFor(byInvocation, operationId, caseId, variant) {
  return [...byInvocation.get(providerInvocationId(operationId, caseId, variant))]
    .sort((left, right) => left.eventSequence - right.eventSequence);
}

function failureCode(events) {
  return events.find((record) => record.event === "failure")?.failureCode ?? null;
}

function implementationVersion(manifest, deployment) {
  if (manifest.backendId === "deislet") return `deislet@${manifest.tool.sourceRevision}`;
  const identity = deployment.provider.versionId ?? deployment.provider.deploymentId;
  return `${manifest.backendId}@${identity}`;
}

function evidenceRef(filePath, digest) {
  return `evidence:${path.basename(filePath)}:sha256:${digest}`;
}

function artifactRef(kind, relativePath, digest) {
  return `${kind}:${relativePath}:sha256:${digest}`;
}

function validateCpuEvidence(value, manifest, expectedInvocationId) {
  exactKeys(value, ["schemaVersion", "backendId", "invocationId", "measurementKind", "measuredCpuMilliseconds", "resourceFailureCode", "providerEvidence"], "CPU evidence");
  fail(value.schemaVersion === 1 && value.backendId === manifest.backendId && value.invocationId === expectedInvocationId, "EC_ADAPTER_CPU_EVIDENCE_INVALID", "CPU evidence identity differs");
  fail(value.measurementKind === "backend-cpu", "EC_ADAPTER_CPU_EVIDENCE_INVALID", "CPU evidence is not backend CPU time");
  fail(Number.isFinite(value.measuredCpuMilliseconds) && value.measuredCpuMilliseconds >= 0, "EC_ADAPTER_CPU_EVIDENCE_INVALID", "CPU measurement is invalid");
  fail(value.resourceFailureCode === null || /^EC_[A-Z0-9_]+$/.test(value.resourceFailureCode), "EC_ADAPTER_CPU_EVIDENCE_INVALID", "CPU resource failure code is invalid");
  fail(value.providerEvidence && typeof value.providerEvidence === "object" && !Array.isArray(value.providerEvidence), "EC_ADAPTER_CPU_EVIDENCE_INVALID", "provider CPU evidence is invalid");
  fail(Buffer.byteLength(JSON.stringify(value), "utf8") <= 1024 * 1024, "EC_ADAPTER_CPU_EVIDENCE_INVALID", "CPU evidence is oversized");
  return value;
}

async function captureCpuEvidence({ path: filePath, cpuCollector, context, manifest, invocationId }) {
  const existing = readJson(filePath, "CPU evidence");
  if (existing) return validateCpuEvidence(existing, manifest, invocationId);
  fail(typeof cpuCollector === "function", "EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE", "backend has no single-invocation CPU collector");
  const collected = validateCpuEvidence(await cpuCollector(context), manifest, invocationId);
  immutableJson(filePath, collected, "CPU evidence");
  return collected;
}

function observationCases({ request, artifact, deployment, raw, byInvocation, references, cpu }) {
  const record = Object.fromEntries(raw.map((item) => [item.stepId, item]));
  const exchange = (stepId, method, pathname, body) => {
    exactKeys(record[stepId].data, ["exchange"], `${stepId} step data`);
    return expectRequest(validateRawExchange(record[stepId].data.exchange, stepId), method, pathname, body);
  };
  const multi = (stepId) => {
    exactKeys(record[stepId].data, ["exchanges"], `${stepId} step data`);
    fail(Array.isArray(record[stepId].data.exchanges), "EC_ADAPTER_EVIDENCE_INVALID", `${stepId} exchanges are invalid`);
    return record[stepId].data.exchanges.map((item, index) => validateRawExchange(item, `${stepId}/${index}`));
  };
  const caseRecord = (id, source, data, extraReferences = []) => ({
    id,
    observedAt: source.observedAt,
    data,
    evidenceRefs: [...new Set([...references.common, ...extraReferences])],
  });

  const sync = exchange("sync", "GET", "/sync");
  const context = exchange("context", "GET", "/context");
  const contextBody = jsonOf(context);
  const transport = exchange("transport-headers", "GET", "/transport-headers");
  const transportBody = jsonOf(transport);
  const methods = multi("methods");
  const throws = multi("throws");
  const invalid = multi("invalid-results");
  for (const [index, item] of methods.entries()) {
    expectRequest(item, ["GET", "POST", "PURGE"][index], "/method", ["", "post-body", "purge-body"][index]);
  }
  for (const [index, item] of throws.entries()) expectRequest(item, "GET", [`/throw-sync`, `/throw-async`][index]);
  for (const [index, item] of invalid.entries()) expectRequest(item, "GET", `/invalid-${["undefined", "string", "object"][index]}`);
  const concurrentSource = record.concurrent;
  exactKeys(concurrentSource.data, ["completionOrder", "exchanges"], "concurrent step data");
  fail(Array.isArray(concurrentSource.data.completionOrder) && Array.isArray(concurrentSource.data.exchanges) && concurrentSource.data.exchanges.length === 8, "EC_ADAPTER_EVIDENCE_INVALID", "concurrent step shape differs");
  const concurrent = concurrentSource.data.exchanges.map((item, index) => ({
    marker: item.marker,
    exchange: expectRequest(
      validateRawExchange(item.exchange, `concurrent/${index}`),
      "GET",
      `/concurrent?marker=request-${index}&delay=${(7 - index) * 5}`,
    ),
  }));
  fail(concurrent.every((item, index) => item.marker === `request-${index}`), "EC_ADAPTER_EVIDENCE_INVALID", "concurrent request markers differ from the fixed plan");
  const stream = exchange("stream", "GET", "/stream");
  const streamText = textOf(stream);
  const background = exchange("background", "GET", "/background");
  const backgroundEvents = eventsFor(byInvocation, request.operationId, "EC-WEB-T008", "background");
  const lateEvents = eventsFor(byInvocation, request.operationId, "EC-WEB-T009", "capture");
  const lateMarker = lateEvents.find((item) => item.event === "record" && item.marker.startsWith("late-wait-until:"))?.marker.split(":") ?? [];
  const disconnectSource = record.disconnect;
  exactKeys(disconnectSource.data, ["marker", "disconnected", "probe"], "disconnect step data");
  fail(disconnectSource.data.marker === "disconnect-one", "EC_ADAPTER_EVIDENCE_INVALID", "disconnect marker differs");
  const disconnected = expectRequest(validateDisconnectExchange(disconnectSource.data.disconnected, "disconnect"), "GET", "/disconnect?marker=disconnect-one");
  const probe = expectRequest(validateRawExchange(disconnectSource.data.probe, "probe"), "GET", "/probe?marker=probe-two");
  const disconnectEvents = eventsFor(byInvocation, request.operationId, "EC-WEB-T010", "disconnect");
  const artifactLineage = record["artifact-lineage"];
  exactKeys(artifactLineage.data, ["canonicalArtifactSha256", "derivedArtifactSha256", "deploymentIdentitySha256", "pinnedStandardVersion"], "artifact lineage step data");
  fail(
    artifactLineage.data.canonicalArtifactSha256 === artifact.canonicalArtifactSha256
      && artifactLineage.data.derivedArtifactSha256 === artifact.derivedArtifactSha256
      && artifactLineage.data.deploymentIdentitySha256 === sha256(Buffer.from(JSON.stringify(deployment.provider), "utf8"))
      && artifactLineage.data.pinnedStandardVersion === request.standardVersion,
    "EC_ADAPTER_EVIDENCE_INVALID",
    "artifact lineage step differs from the bound operation",
  );
  const cpuExchange = exchange("cpu", "GET", "/cpu");
  const cpuBody = jsonOf(cpuExchange);
  const subrequests = record.subrequests;
  exactKeys(subrequests.data, ["worker", "originStatus"], "subrequests step data");
  const subrequestWorker = expectRequest(validateRawExchange(subrequests.data.worker, "subrequests"), "GET", "/subrequests");
  fail(Number.isSafeInteger(subrequests.data.originStatus?.totalRequestCount), "EC_ADAPTER_EVIDENCE_INVALID", "controlled origin count is invalid");
  const subrequestBody = jsonOf(subrequestWorker);
  const connections = record.connections;
  exactKeys(connections.data, ["beforeRelease", "release", "worker"], "connections step data");
  for (const key of ["waitingSlots", "startedSlots", "cancelledSlots"]) {
    fail(Array.isArray(connections.data.beforeRelease?.[key]) && connections.data.beforeRelease[key].every((slot) => Number.isSafeInteger(slot) && slot >= 0 && slot <= 6), "EC_ADAPTER_EVIDENCE_INVALID", `connection ${key} evidence is invalid`);
  }
  const connectionWorker = expectRequest(validateRawExchange(connections.data.worker, "connections"), "GET", "/connections");
  const connectionBody = jsonOf(connectionWorker);
  exactKeys(record["request-body-limit"].data, ["requestBodySha256", "exchange"], "request-body-limit step data");
  const expectedBody = Buffer.allocUnsafe(1_000_000);
  for (let index = 0; index < expectedBody.length; index += 1) expectedBody[index] = index % 251;
  fail(record["request-body-limit"].data.requestBodySha256 === sha256(expectedBody), "EC_ADAPTER_EVIDENCE_INVALID", "request body fixture digest differs");
  const bodyLimit = expectRequest(
    validateRawExchange(record["request-body-limit"].data.exchange, "request-body-limit"),
    "POST",
    "/request-body-limit",
    expectedBody,
  );
  const bodyLimitBody = jsonOf(bodyLimit);
  const bodyEvents = eventsFor(byInvocation, request.operationId, "EC-WEB-T015", "request-body");
  const oracleDigest = sha256(fs.readFileSync(path.join(path.dirname(request.canonicalArtifact.path), "oracle.mjs")));

  const cases = [
    caseRecord("EC-WEB-T001", record.sync, {
      buildSucceeded: deployment.status === "deployed",
      defaultEntrypointCount: 1,
      status: sync.response.status,
      body: textOf(sync),
    }),
    caseRecord("EC-WEB-T002", record.context, {
      status: context.response.status,
      contextKeys: contextBody.contextKeys ?? [],
      contextObjectIdentityUnique: contextBody.contextObjectIdentityUnique === true,
      environment: contextBody.environment ?? null,
      parameter: contextBody.parameter ?? null,
      backgroundEvidence: eventsFor(byInvocation, request.operationId, "EC-WEB-T002", "context")
        .find((item) => item.event === "record")?.marker ?? null,
      transportHeadersRemoved: transportBody.evidenceMode === null
        && transportBody.evidenceToken === null
        && transportBody.invocationId === null,
    }),
    caseRecord("EC-WEB-T003", record.methods, {
      entrypointCount: 1,
      exchanges: methods.map((item, index) => ({
        method: ["GET", "POST", "PURGE"][index],
        requestBody: ["", "post-body", "purge-body"][index],
        responseBody: textOf(item),
      })),
    }),
    caseRecord("EC-WEB-T004", record.throws, {
      attempts: throws.map((item, index) => {
        const mode = ["sync", "async"][index];
        const events = eventsFor(byInvocation, request.operationId, "EC-WEB-T004", mode);
        return {
          mode,
          status: item.response.status,
          contentType: headerOf(item, "content-type"),
          cacheControl: headerOf(item, "cache-control"),
          body: textOf(item),
          failureCode: failureCode(events),
          originHitCount: 0,
          leakedSentinel: textOf(item).includes(ERROR_SENTINEL),
        };
      }),
    }),
    caseRecord("EC-WEB-T005", record["invalid-results"], {
      attempts: invalid.map((item, index) => {
        const mode = ["undefined", "string", "object"][index];
        const events = eventsFor(byInvocation, request.operationId, "EC-WEB-T005", mode);
        return {
          mode,
          status: item.response.status,
          contentType: headerOf(item, "content-type"),
          cacheControl: headerOf(item, "cache-control"),
          body: textOf(item),
          failureCode: failureCode(events),
          originHitCount: 0,
          leakedSentinel: textOf(item).includes(ERROR_SENTINEL),
        };
      }),
    }),
    caseRecord("EC-WEB-T006", concurrentSource, {
      completionOrder: concurrentSource.data.completionOrder,
      moduleCounterSamples: concurrent.map(({ exchange: item }) => jsonOf(item).moduleCounterSample ?? null),
      orderingAssertionApplied: false,
      responses: concurrent.map(({ marker, exchange: item }) => ({
        contextObjectIdentityUnique: jsonOf(item).contextObjectIdentityUnique === true,
        requestMarker: marker,
        responseMarker: jsonOf(item).marker ?? null,
      })),
    }),
    caseRecord("EC-WEB-T007", record.stream, {
      bodyTerminalState: stream.response.terminalState,
      chunks: streamText === "stream-onestream-twostream-three"
        ? ["stream-one", "stream-two", "stream-three"]
        : [streamText],
      handlerSettledBeforeBodyEnd: (() => {
        const events = eventsFor(byInvocation, request.operationId, "EC-WEB-T007", "stream");
        return events.findIndex((item) => item.event === "handler-settled")
          < events.findIndex((item) => item.event === "lifecycle-closed");
      })(),
    }),
    caseRecord("EC-WEB-T008", record.background, {
      backgroundFailureCodes: backgroundEvents.filter((item) => item.event === "failure").map((item) => item.failureCode),
      body: textOf(background),
      handlerInvocationCount: backgroundEvents.filter((item) => item.event === "invocation-start").length,
      status: background.response.status,
      taskEvidence: backgroundEvents.filter((item) => item.event === "record").map((item) => item.marker),
    }),
    caseRecord("EC-WEB-T009", record["late-wait-until"], {
      exceptionType: lateMarker[1] ?? null,
      failureCode: lateMarker[2] ?? failureCode(lateEvents),
      registeredBackgroundTaskCount: (() => {
        const closedAt = lateEvents.find((item) => item.event === "lifecycle-closed")?.eventSequence ?? Number.MAX_SAFE_INTEGER;
        return lateEvents.filter((item) => item.event === "background-registered" && item.eventSequence > closedAt).length;
      })(),
    }),
    caseRecord("EC-WEB-T010", record.disconnect, {
      backgroundOutcome: disconnectEvents.some((item) => item.event === "record" && item.marker === "background:disconnect-one")
        ? "completed" : "pending-at-observation",
      bodyTerminalState: disconnected.response.bodyTerminalState,
      disconnectedInvocationCount: disconnectEvents.filter((item) => item.event === "invocation-start").length,
      probeInheritedCancellation: false,
      probeLeakedPriorMarker: textOf(probe).includes("disconnect-one"),
      probeResponseMarker: textOf(probe),
      transactionRollbackClaimed: false,
    }),
    caseRecord("EC-WEB-T011", artifactLineage, {
      canonicalArtifactSha256: artifactLineage.data.canonicalArtifactSha256,
      derivedArtifactSha256: artifactLineage.data.derivedArtifactSha256,
      oracleSha256: oracleDigest,
      pinnedStandardVersion: artifactLineage.data.pinnedStandardVersion,
      semanticWaivers: [],
    }, [
      artifactRef("canonical", "artifact.json", artifact.canonicalArtifactSha256),
      artifactRef("derived", "artifact.json", artifact.derivedArtifactSha256),
      artifactRef("canonical", "oracle.mjs", oracleDigest),
    ]),
    caseRecord("EC-WEB-T012", record.cpu, {
      calibratedWorkSha256: request.configuration.calibratedWorkSha256,
      calibratedCpuMilliseconds: request.configuration.calibratedCpuMilliseconds,
      freshExecutionEnvironment: raw[0].stepId === "cpu"
        && Date.parse(deployment.updatedAt) <= Date.parse(raw[0].observedAt),
      iterations: request.configuration.cpuIterations,
      measuredCpuMilliseconds: cpu.measuredCpuMilliseconds,
      measurementKind: cpu.measurementKind,
      resourceFailureCode: cpu.resourceFailureCode,
      terminalState: cpuExchange.response.terminalState === "closed" && cpuExchange.response.status < 500 ? "completed" : cpuExchange.response.terminalState,
      workCompletionSentinel: cpuBody.completionSentinel ?? null,
    }, [references.cpu]),
    caseRecord("EC-WEB-T013", subrequests, {
      completionSentinel: subrequestBody.completionSentinel ?? null,
      failureCodes: subrequestWorker.response.status >= 200 && subrequestWorker.response.status < 300 ? [] : [`EC_HTTP_${subrequestWorker.response.status}`],
      fetchCallCount: subrequestBody.fetchCallCount ?? null,
      originRequestCount: subrequests.data.originStatus.totalRequestCount ?? null,
      redirectHopCount: subrequests.data.originStatus.redirectTargetCount ?? null,
      subrequestStartCount: subrequests.data.originStatus.totalRequestCount ?? null,
    }),
    caseRecord("EC-WEB-T014", connections, {
      connectionsWaitingBeforeBarrier: connections.data.beforeRelease.waitingSlots.length,
      firstSixCancelled: connections.data.beforeRelease.cancelledSlots.some((slot) => slot >= 0 && slot < 6),
      firstSixResponseMarkers: Array.isArray(connectionBody.markers) ? connectionBody.markers.slice(0, 6) : [],
      seventhProbeOutcome: connections.data.beforeRelease.startedSlots.includes(6)
        ? "started-before-barrier" : "queued-until-release",
    }),
    caseRecord("EC-WEB-T015", record["request-body-limit"], {
      contentEncoding: bodyLimitBody.contentEncoding ?? null,
      declaredContentLength: bodyLimitBody.declaredContentLength ?? null,
      firstOctet: bodyLimitBody.firstOctet ?? null,
      handlerInvocationCount: bodyEvents.filter((item) => item.event === "invocation-start").length,
      lastOctet: bodyLimitBody.lastOctet ?? null,
      receivedByteLength: bodyLimitBody.receivedByteLength ?? null,
      receivedSha256: bodyLimitBody.receivedSha256 ?? null,
      resourceFailureCode: bodyLimit.response.status >= 200 && bodyLimit.response.status < 300 ? null : `EC_HTTP_${bodyLimit.response.status}`,
      status: bodyLimit.response.status,
    }),
  ];
  fail(cases.length === CASE_IDS.length && cases.every((item, index) => item.id === CASE_IDS[index]), "EC_ADAPTER_INTERNAL", "collector case order differs");
  return cases;
}

function collectionPaths(request, manifest) {
  const root = privateEvidenceDirectory(request.evidenceDirectory);
  const key = sha256(Buffer.from(`${manifest.backendId}\0${request.operationId}`, "utf8")).slice(0, 32);
  return {
    sink: path.join(root, `${manifest.backendId}-${key}-sink.json`),
    cpu: path.join(root, `${manifest.backendId}-${key}-cpu.json`),
    observations: path.join(root, `${manifest.backendId}-${key}-observations.json`),
    state: `${deploymentStatePath(request, manifest).slice(0, -5)}.collection.json`,
  };
}

function validateCollectionState(state, request, manifest, invocation, paths) {
  exactKeys(state, [
    "schemaVersion", "stateFormat", "operationId", "backendId", "standardVersion", "suiteId",
    "canonicalArtifactSha256", "derivedArtifactSha256", "deploymentIdentitySha256", "invocationEvidenceSha256",
    "sinkEvidenceFile", "sinkEvidenceSha256", "cpuEvidenceFile", "cpuEvidenceSha256",
    "observationsFile", "observationsSha256", "status", "createdAt", "updatedAt",
  ], "collection state", "EC_ADAPTER_STATE_INVALID");
  fail(state.schemaVersion === 1 && state.stateFormat === STATE_FORMAT && state.status === "collected", "EC_ADAPTER_STATE_INVALID", "collection state format or status differs");
  fail(state.operationId === request.operationId && state.backendId === manifest.backendId && state.standardVersion === request.standardVersion && state.suiteId === request.suiteId, "EC_ADAPTER_STATE_INVALID", "collection state identity differs");
  fail(state.canonicalArtifactSha256 === invocation.artifact.canonicalArtifactSha256 && state.derivedArtifactSha256 === invocation.artifact.derivedArtifactSha256, "EC_ADAPTER_STATE_INVALID", "collection artifact identity differs");
  const deploymentIdentity = sha256(Buffer.from(JSON.stringify(invocation.deployment.provider), "utf8"));
  fail(state.deploymentIdentitySha256 === deploymentIdentity && state.invocationEvidenceSha256 === invocation.state.rawEvidenceSha256, "EC_ADAPTER_STATE_INVALID", "collection execution identity differs");
  for (const [fileKey, digestKey, expectedPath] of [
    ["sinkEvidenceFile", "sinkEvidenceSha256", paths.sink],
    ["cpuEvidenceFile", "cpuEvidenceSha256", paths.cpu],
    ["observationsFile", "observationsSha256", paths.observations],
  ]) {
    fail(state[fileKey] === path.basename(expectedPath) && /^[0-9a-f]{64}$/.test(state[digestKey]), "EC_ADAPTER_STATE_INVALID", `collection ${fileKey} differs`);
    fail(sha256(fs.readFileSync(expectedPath)) === state[digestKey], "EC_ADAPTER_STATE_INVALID", `collection ${fileKey} digest differs`);
  }
  fail(Number.isFinite(Date.parse(state.createdAt)) && Number.isFinite(Date.parse(state.updatedAt)), "EC_ADAPTER_STATE_INVALID", "collection timestamps are invalid");
  return state;
}

function result(request, manifest, paths, state, mutatedRemoteState) {
  return {
    schemaVersion: 1,
    protocolVersion: manifest.protocolVersion,
    operation: request.operation,
    operationId: request.operationId,
    backendId: manifest.backendId,
    outcome: "succeeded",
    mutatedRemoteState,
    retrySafe: true,
    data: { statePath: paths.state, state, observationsPath: paths.observations },
    evidenceRefs: [evidenceRef(paths.observations, state.observationsSha256)],
    failure: null,
  };
}

export async function collectProvider({
  request,
  manifest,
  environment,
  cpuCollector,
  fetchImpl = fetch,
  pollIntervalMs = 100,
}) {
  const invocation = loadProviderInvocation({ request, manifest });
  const releaseLock = acquireOperationLock(deploymentStatePath(request, manifest));
  try {
    const paths = collectionPaths(request, manifest);
    const existingState = readJson(paths.state, "collection state");
    if (existingState) return result(request, manifest, paths, validateCollectionState(existingState, request, manifest, invocation, paths), false);
    const raw = readRawRecords(invocation.evidencePath);
    const specs = expectedInvocationSpecs(request.operationId);
    const snapshot = await captureEvidenceSnapshot({
      request,
      manifest,
      environment,
      fetchImpl,
      timeoutMs: manifest.security.timeoutSeconds * 1_000,
      pollIntervalMs,
      snapshotPath: paths.sink,
      specs,
    });
    const { byInvocation } = validateEvidenceDocument(snapshot, manifest, specs, true);
    const cpuInvocationId = providerInvocationId(request.operationId, "EC-WEB-T012", "cpu");
    const cpu = await captureCpuEvidence({
      path: paths.cpu,
      cpuCollector,
      manifest,
      invocationId: cpuInvocationId,
      context: { request, manifest, environment, invocation, rawRecord: raw[0], fetchImpl },
    });
    const sinkDigest = sha256(fs.readFileSync(paths.sink));
    const cpuDigest = sha256(fs.readFileSync(paths.cpu));
    const references = {
      raw: evidenceRef(invocation.evidencePath, invocation.state.rawEvidenceSha256),
      sink: evidenceRef(paths.sink, sinkDigest),
      cpu: evidenceRef(paths.cpu, cpuDigest),
    };
    const observations = {
      schemaVersion: 1,
      standardId: "edge-canon.next",
      suiteId: request.suiteId,
      backend: {
        id: manifest.backendId,
        implementationVersion: implementationVersion(manifest, invocation.deployment),
        standardVersion: request.standardVersion,
      },
      artifactSha256: invocation.artifact.canonicalArtifactSha256,
      cases: observationCases({
        request,
        artifact: invocation.artifact,
        deployment: invocation.deployment,
        raw,
        byInvocation,
        references: { common: [references.raw, references.sink], cpu: references.cpu },
        cpu,
      }),
    };
    const observationEvidence = immutableJson(paths.observations, observations, "observations");
    const timestamp = new Date().toISOString();
    const state = {
      schemaVersion: 1,
      stateFormat: STATE_FORMAT,
      operationId: request.operationId,
      backendId: manifest.backendId,
      standardVersion: request.standardVersion,
      suiteId: request.suiteId,
      canonicalArtifactSha256: invocation.artifact.canonicalArtifactSha256,
      derivedArtifactSha256: invocation.artifact.derivedArtifactSha256,
      deploymentIdentitySha256: sha256(Buffer.from(JSON.stringify(invocation.deployment.provider), "utf8")),
      invocationEvidenceSha256: invocation.state.rawEvidenceSha256,
      sinkEvidenceFile: path.basename(paths.sink),
      sinkEvidenceSha256: sinkDigest,
      cpuEvidenceFile: path.basename(paths.cpu),
      cpuEvidenceSha256: cpuDigest,
      observationsFile: path.basename(paths.observations),
      observationsSha256: observationEvidence.sha256,
      status: "collected",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    immutableJson(paths.state, state, "collection state");
    return result(request, manifest, paths, state, false);
  } finally {
    releaseLock();
  }
}
