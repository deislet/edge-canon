import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const INVOCATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const EVENTS_PATH = "/events";
const CONTROL_PREFIX = "/__edge-canon/control";

export class HarnessServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HarnessServiceError";
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (!condition) throw new HarnessServiceError(code, message);
}

function exactKeys(value, keys, label) {
  fail(value && typeof value === "object" && !Array.isArray(value), "EC_HARNESS_EVENT_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  fail(JSON.stringify(actual) === JSON.stringify(expected), "EC_HARNESS_EVENT_INVALID", `${label} keys differ`);
}

function secureEqual(left, right) {
  const leftBytes = Buffer.from(left ?? "", "utf8");
  const rightBytes = Buffer.from(right ?? "", "utf8");
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

function authenticate(request, token) {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ")
    && secureEqual(value.slice("Bearer ".length), token);
}

function validateEvent(record) {
  fail(record && typeof record === "object" && !Array.isArray(record), "EC_HARNESS_EVENT_INVALID", "event must be an object");
  const required = ["schemaVersion", "backendId", "event", "invocationId", "eventSequence"];
  for (const key of required) fail(Object.hasOwn(record, key), "EC_HARNESS_EVENT_INVALID", `event has no ${key}`);
  fail(record.schemaVersion === 1, "EC_HARNESS_EVENT_INVALID", "event schemaVersion differs");
  fail(["cloudflare-workers-pages", "tencent-edgeone-makers", "deislet"].includes(record.backendId), "EC_HARNESS_EVENT_INVALID", "event backend is unknown");
  fail(record.invocationId === null || INVOCATION_ID.test(record.invocationId), "EC_HARNESS_EVENT_INVALID", "event invocationId is invalid");
  fail(Number.isSafeInteger(record.eventSequence) && record.eventSequence >= 0, "EC_HARNESS_EVENT_INVALID", "event sequence is invalid");
  const base = ["schemaVersion", "backendId", "event", "invocationId", "eventSequence"];
  switch (record.event) {
    case "invocation-start":
      exactKeys(record, [...base, "method", "pathname"], "invocation-start event");
      fail(typeof record.method === "string" && /^[A-Z]+$/.test(record.method), "EC_HARNESS_EVENT_INVALID", "event method is invalid");
      fail(typeof record.pathname === "string" && record.pathname.startsWith("/") && record.pathname.length <= 2048, "EC_HARNESS_EVENT_INVALID", "event pathname is invalid");
      break;
    case "record":
      exactKeys(record, [...base, "marker"], "record event");
      fail(typeof record.marker === "string" && record.marker.length <= 256, "EC_HARNESS_EVENT_INVALID", "event marker is invalid");
      break;
    case "background-registered":
      exactKeys(record, [...base, "taskNumber"], "background-registered event");
      fail(Number.isSafeInteger(record.taskNumber) && record.taskNumber > 0, "EC_HARNESS_EVENT_INVALID", "event taskNumber is invalid");
      break;
    case "failure": {
      const keys = record.taskNumber === undefined ? [...base, "failureCode"] : [...base, "failureCode", "taskNumber"];
      exactKeys(record, keys, "failure event");
      fail(/^EC_[A-Z0-9_]+$/.test(record.failureCode), "EC_HARNESS_EVENT_INVALID", "event failureCode is invalid");
      if (record.taskNumber !== undefined) {
        fail(Number.isSafeInteger(record.taskNumber) && record.taskNumber > 0, "EC_HARNESS_EVENT_INVALID", "failure taskNumber is invalid");
      }
      break;
    }
    case "handler-settled":
      exactKeys(record, base, "handler-settled event");
      break;
    case "lifecycle-closed":
      exactKeys(record, [...base, "registeredBackgroundTaskCount", "terminalState"], "lifecycle-closed event");
      fail(Number.isSafeInteger(record.registeredBackgroundTaskCount) && record.registeredBackgroundTaskCount >= 0, "EC_HARNESS_EVENT_INVALID", "background task count is invalid");
      fail(["no-body", "closed", "errored", "cancelled"].includes(record.terminalState), "EC_HARNESS_EVENT_INVALID", "terminal state is invalid");
      break;
    default:
      throw new HarnessServiceError("EC_HARNESS_EVENT_INVALID", "event kind is unknown");
  }
  return record;
}

function privateDirectory(directory) {
  fail(typeof directory === "string" && path.isAbsolute(directory), "EC_HARNESS_CONFIGURATION_INVALID", "stateDirectory must be absolute");
  const status = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (status) {
    fail(status.isDirectory() && !status.isSymbolicLink(), "EC_HARNESS_CONFIGURATION_INVALID", "stateDirectory is not a regular directory");
  } else {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  fs.chmodSync(directory, 0o700);
  fail(fs.realpathSync(directory) === path.resolve(directory), "EC_HARNESS_CONFIGURATION_INVALID", "stateDirectory traverses a symbolic link");
  return path.resolve(directory);
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

function loadEvidence(filePath) {
  const status = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!status) return [];
  fail(status.isFile() && !status.isSymbolicLink(), "EC_HARNESS_STATE_INVALID", "evidence path is not a regular file");
  fail(status.size <= MAX_EVIDENCE_BYTES, "EC_HARNESS_STATE_INVALID", "evidence file is oversized");
  const text = fs.readFileSync(filePath, "utf8");
  if (!text) return [];
  fail(text.endsWith("\n"), "EC_HARNESS_STATE_INVALID", "evidence file has a partial final record");
  return text.trimEnd().split("\n").map((line, index) => {
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch (error) {
      throw new HarnessServiceError("EC_HARNESS_STATE_INVALID", `evidence record ${index} is invalid JSON: ${error.message}`);
    }
    exactKeys(envelope, ["schemaVersion", "sinkSequence", "receivedAt", "record"], `evidence envelope ${index}`);
    fail(envelope.schemaVersion === 1 && envelope.sinkSequence === index, "EC_HARNESS_STATE_INVALID", "evidence sequence differs");
    fail(Number.isFinite(Date.parse(envelope.receivedAt)), "EC_HARNESS_STATE_INVALID", "evidence timestamp is invalid");
    validateEvent(envelope.record);
    return envelope;
  });
}

function writeJson(response, status, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
  });
  response.end(bytes);
}

function writeText(response, status, value, headers = {}) {
  const bytes = Buffer.from(value, "utf8");
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
    ...headers,
  });
  response.end(bytes);
}

async function readBody(request) {
  const declared = Number.parseInt(request.headers["content-length"] ?? "", 10);
  fail(!Number.isFinite(declared) || declared <= MAX_EVENT_BYTES, "EC_HARNESS_EVENT_INVALID", "event body is oversized");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    fail(size <= MAX_EVENT_BYTES, "EC_HARNESS_EVENT_INVALID", "event body is oversized");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function errorStatus(error) {
  if (!(error instanceof HarnessServiceError)) return 500;
  if (error.code === "EC_HARNESS_UNAUTHORIZED") return 401;
  if (error.code === "EC_HARNESS_CONFLICT") return 409;
  if (error.code === "EC_HARNESS_NOT_FOUND") return 404;
  return 400;
}

export async function startHarnessService({ stateDirectory, token, host = "127.0.0.1", port = 0 }) {
  fail(TOKEN.test(token ?? ""), "EC_HARNESS_CONFIGURATION_INVALID", "token must contain 32 to 256 URL-safe characters");
  fail(typeof host === "string" && host.length > 0, "EC_HARNESS_CONFIGURATION_INVALID", "host is invalid");
  fail(Number.isSafeInteger(port) && port >= 0 && port <= 65535, "EC_HARNESS_CONFIGURATION_INVALID", "port is invalid");
  const root = privateDirectory(stateDirectory);
  const evidencePath = path.join(root, "evidence.ndjson");
  const records = loadEvidence(evidencePath);
  const eventKeys = new Set();
  for (const envelope of records) {
    const key = `${envelope.record.backendId}\0${envelope.record.invocationId}\0${envelope.record.eventSequence}`;
    fail(!eventKeys.has(key), "EC_HARNESS_STATE_INVALID", "evidence file contains a duplicate event identity");
    eventKeys.add(key);
  }
  const origin = { armed: false, directIndices: [], redirectRequestCount: 0, redirectTargetCount: 0 };
  const barrier = {
    armed: false,
    released: false,
    startedSlots: [],
    waiting: new Map(),
    cancelledSlots: [],
  };

  async function route(request, response) {
    const url = new URL(request.url, "http://harness.invalid");
    if (url.pathname === EVENTS_PATH) {
      fail(authenticate(request, token), "EC_HARNESS_UNAUTHORIZED", "authentication failed");
      if (request.method === "GET") {
        writeJson(response, 200, { schemaVersion: 1, records });
        return;
      }
      fail(request.method === "POST", "EC_HARNESS_NOT_FOUND", "route not found");
      fail(request.headers["content-encoding"] === undefined, "EC_HARNESS_EVENT_INVALID", "event body must use identity coding");
      fail(request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() === "application/json", "EC_HARNESS_EVENT_INVALID", "event content type must be application/json");
      const body = await readBody(request);
      let record;
      try {
        record = JSON.parse(body.toString("utf8"));
      } catch (error) {
        throw new HarnessServiceError("EC_HARNESS_EVENT_INVALID", `event is not JSON: ${error.message}`);
      }
      validateEvent(record);
      const key = `${record.backendId}\0${record.invocationId}\0${record.eventSequence}`;
      fail(!eventKeys.has(key), "EC_HARNESS_CONFLICT", "event identity already exists");
      const envelope = {
        schemaVersion: 1,
        sinkSequence: records.length,
        receivedAt: new Date().toISOString(),
        record,
      };
      const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
      const existingSize = fs.statSync(evidencePath, { throwIfNoEntry: false })?.size ?? 0;
      fail(existingSize + bytes.byteLength <= MAX_EVIDENCE_BYTES, "EC_HARNESS_STATE_INVALID", "evidence file limit reached");
      const descriptor = fs.openSync(evidencePath, "a", 0o600);
      try {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.chmodSync(evidencePath, 0o600);
      if (records.length === 0) syncDirectory(root);
      records.push(envelope);
      eventKeys.add(key);
      writeJson(response, 202, { accepted: true, sinkSequence: envelope.sinkSequence });
      return;
    }

    if (url.pathname.startsWith(`${CONTROL_PREFIX}/`)) {
      fail(authenticate(request, token), "EC_HARNESS_UNAUTHORIZED", "authentication failed");
      if (url.pathname === `${CONTROL_PREFIX}/origin/reset` && request.method === "POST") {
        fail(origin.directIndices.length === 0 && origin.redirectRequestCount === 0 && origin.redirectTargetCount === 0, "EC_HARNESS_CONFLICT", "origin already received requests");
        origin.armed = true;
        writeJson(response, 200, { armed: true });
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/origin/status` && request.method === "GET") {
        writeJson(response, 200, {
          armed: origin.armed,
          directIndices: [...origin.directIndices].sort((a, b) => a - b),
          redirectRequestCount: origin.redirectRequestCount,
          redirectTargetCount: origin.redirectTargetCount,
          totalRequestCount: origin.directIndices.length + origin.redirectRequestCount + origin.redirectTargetCount,
        });
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/barrier/reset` && request.method === "POST") {
        fail(barrier.startedSlots.length === 0 && barrier.waiting.size === 0 && !barrier.released, "EC_HARNESS_CONFLICT", "barrier already received requests");
        barrier.armed = true;
        writeJson(response, 200, { armed: true });
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/barrier/status` && request.method === "GET") {
        writeJson(response, 200, {
          armed: barrier.armed,
          released: barrier.released,
          waitingSlots: [...barrier.waiting.keys()].sort((a, b) => a - b),
          startedSlots: [...barrier.startedSlots].sort((a, b) => a - b),
          cancelledSlots: [...barrier.cancelledSlots].sort((a, b) => a - b),
        });
        return;
      }
      if (url.pathname === `${CONTROL_PREFIX}/barrier/release` && request.method === "POST") {
        fail(barrier.armed, "EC_HARNESS_CONFLICT", "barrier is not armed");
        barrier.released = true;
        const releasedSlots = [...barrier.waiting.keys()].sort((a, b) => a - b);
        for (const [slot, waitingResponse] of barrier.waiting) {
          writeText(waitingResponse, 200, `connection-${slot}`);
        }
        barrier.waiting.clear();
        writeJson(response, 200, { releasedSlots });
        return;
      }
      throw new HarnessServiceError("EC_HARNESS_NOT_FOUND", "control route not found");
    }

    const direct = /^\/direct\/(\d+)$/.exec(url.pathname);
    if (direct && request.method === "GET") {
      fail(origin.armed, "EC_HARNESS_CONFLICT", "origin is not armed");
      const index = Number.parseInt(direct[1], 10);
      fail(index >= 0 && index < 48, "EC_HARNESS_NOT_FOUND", "direct index is outside the fixture");
      fail(!origin.directIndices.includes(index), "EC_HARNESS_CONFLICT", "direct index was requested twice");
      origin.directIndices.push(index);
      writeText(response, 200, `direct-${index}`);
      return;
    }
    if (url.pathname === "/redirect-once" && request.method === "GET") {
      fail(origin.armed, "EC_HARNESS_CONFLICT", "origin is not armed");
      origin.redirectRequestCount += 1;
      fail(origin.redirectRequestCount === 1, "EC_HARNESS_CONFLICT", "redirect entry was requested twice");
      writeText(response, 302, "redirect", { location: "/redirect-target" });
      return;
    }
    if (url.pathname === "/redirect-target" && request.method === "GET") {
      fail(origin.armed, "EC_HARNESS_CONFLICT", "origin is not armed");
      origin.redirectTargetCount += 1;
      fail(origin.redirectTargetCount === 1, "EC_HARNESS_CONFLICT", "redirect target was requested twice");
      writeText(response, 200, "redirect-target");
      return;
    }

    const slotMatch = /^\/slot\/(\d+)$/.exec(url.pathname);
    if (slotMatch && request.method === "GET") {
      fail(barrier.armed, "EC_HARNESS_CONFLICT", "barrier is not armed");
      const slot = Number.parseInt(slotMatch[1], 10);
      fail(slot >= 0 && slot <= 6, "EC_HARNESS_NOT_FOUND", "barrier slot is outside the fixture");
      fail(!barrier.startedSlots.includes(slot), "EC_HARNESS_CONFLICT", "barrier slot was requested twice");
      barrier.startedSlots.push(slot);
      if (barrier.released) {
        writeText(response, 200, `connection-${slot}`);
        return;
      }
      barrier.waiting.set(slot, response);
      response.on("close", () => {
        if (!response.writableEnded && barrier.waiting.delete(slot)) barrier.cancelledSlots.push(slot);
      });
      return;
    }
    throw new HarnessServiceError("EC_HARNESS_NOT_FOUND", "route not found");
  }

  const server = http.createServer((request, response) => {
    route(request, response).catch((error) => {
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      writeJson(response, errorStatus(error), {
        error: error instanceof HarnessServiceError ? error.code : "EC_HARNESS_INTERNAL",
      });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  fail(address && typeof address === "object", "EC_HARNESS_INTERNAL", "server has no bound address");
  const authority = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const baseUrl = `http://${authority}:${address.port}`;
  return {
    baseUrl,
    evidenceSinkUrl: `${baseUrl}${EVENTS_PATH}`,
    controlledOriginUrl: baseUrl,
    connectionBarrierOriginUrl: baseUrl,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function main(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    fail(argv[index]?.startsWith("--") && argv[index + 1] !== undefined, "EC_HARNESS_CONFIGURATION_INVALID", "arguments must be --name value pairs");
    values.set(argv[index].slice(2), argv[index + 1]);
  }
  const tokenName = values.get("token-env") ?? "EDGE_CANON_EVIDENCE_TOKEN";
  fail(/^[A-Z][A-Z0-9_]*$/.test(tokenName), "EC_HARNESS_CONFIGURATION_INVALID", "token environment name is invalid");
  const service = await startHarnessService({
    stateDirectory: values.get("state-directory"),
    token: process.env[tokenName],
    host: values.get("host") ?? "127.0.0.1",
    port: Number.parseInt(values.get("port") ?? "0", 10),
  });
  process.stdout.write(`${JSON.stringify({
    evidenceSinkUrl: service.evidenceSinkUrl,
    controlledOriginUrl: service.controlledOriginUrl,
    connectionBarrierOriginUrl: service.connectionBarrierOriginUrl,
  })}\n`);
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof HarnessServiceError ? error.code : "EC_HARNESS_INTERNAL"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
