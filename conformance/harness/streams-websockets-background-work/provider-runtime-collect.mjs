import { createHash } from "node:crypto";
import fs from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_STANDARD = /^edge-canon\.next@[0-9a-f]{40}$/;
const MAX_JSON_OCTETS = 1_048_576;
const REQUEST_TIMEOUT_MS = 10_000;

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function validateConfig(config) {
  requireValue(config && typeof config === "object" && !Array.isArray(config), "collector config must be an object");
  requireValue(JSON.stringify(Object.keys(config).sort()) === JSON.stringify(["artifactSha256", "baseUrl", "provider", "standardVersion"].sort()), "collector config fields differ");
  requireValue(EXACT_STANDARD.test(config.standardVersion), "collector standardVersion must be an exact Edge Canon commit");
  requireValue(SHA256.test(config.artifactSha256), "collector artifactSha256 is invalid");
  requireValue(config.provider && typeof config.provider === "object" && !Array.isArray(config.provider), "collector provider is invalid");
  requireValue(JSON.stringify(Object.keys(config.provider).sort()) === JSON.stringify(["id", "implementationVersion", "deploymentId"].sort()), "collector provider fields differ");
  for (const [key, value] of Object.entries(config.provider)) requireValue(typeof value === "string" && value.length > 0, `collector provider ${key} is missing`);
  const base = new URL(config.baseUrl);
  const loopback = base.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(base.hostname);
  requireValue(base.protocol === "https:" || loopback, "collector baseUrl must use HTTPS or HTTP loopback");
  requireValue(!base.username && !base.password && !base.search && !base.hash, "collector baseUrl must not contain credentials, query or fragment");
  return base;
}

function requestUrl(base, relative) {
  const root = new URL(base.href);
  if (!root.pathname.endsWith("/")) root.pathname += "/";
  return new URL(relative.replace(/^\//, ""), root);
}

function contentType(response) {
  return (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
}

async function request(fetchImpl, url) {
  return fetchImpl(url.href, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function readJson(response, label) {
  requireValue(response.status === 200, `${label} returned HTTP ${response.status}`);
  const bytes = await readLimitedBody(response, MAX_JSON_OCTETS, label);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(`${label} did not return valid UTF-8 JSON`);
  }
}

async function readLimitedBody(response, maximum, label) {
  requireValue(response.body !== null, `${label} has no body`);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel(`${label} exceeded the response body limit`);
      fail(`${label} exceeded the response body limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function collectStream(fetchImpl, url) {
  const response = await request(fetchImpl, url);
  const headersAt = performance.now();
  requireValue(response.body !== null, "stream response has no body");
  const reader = response.body.getReader();
  const bytes = [];
  let firstChunkBeforeBodyEnd = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    firstChunkBeforeBodyEnd = true;
    bytes.push(...value);
    if (bytes.length > MAX_JSON_OCTETS) {
      await reader.cancel("stream response exceeded the response body limit");
      fail("stream response exceeded the response body limit");
    }
  }
  const bodyEndedAt = performance.now();
  return {
    status: response.status,
    contentType: contentType(response),
    caseHeader: response.headers.get("x-edge-canon-case"),
    body: bytes,
    headersBeforeBodyEnd: firstChunkBeforeBodyEnd && bodyEndedAt > headersAt,
    bodyDurationAfterHeadersMs: bodyEndedAt - headersAt,
    replacementResponses: response.redirected ? 1 : 0,
  };
}

async function collectCapacity(fetchImpl, url) {
  const response = await request(fetchImpl, url);
  const body = await readLimitedBody(response, MAX_JSON_OCTETS, "capacity response");
  return {
    status: response.status,
    contentType: contentType(response),
    caseHeader: response.headers.get("x-edge-canon-case"),
    bodyOctets: body.byteLength,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    declaredChunkOctets: Number(response.headers.get("x-edge-canon-chunk-octets")),
    declaredTotalOctets: Number(response.headers.get("x-edge-canon-total-octets")),
  };
}

export async function collectProviderRuntimeEvidence(config, fetchImpl = fetch) {
  const base = validateConfig(config);
  const [a, b, stream, capacity] = await Promise.all([
    request(fetchImpl, requestUrl(base, "?label=A")).then((response) => readJson(response, "probe A")),
    request(fetchImpl, requestUrl(base, "?label=B")).then((response) => readJson(response, "probe B")),
    collectStream(fetchImpl, requestUrl(base, "stream")),
    collectCapacity(fetchImpl, requestUrl(base, "capacity")),
  ]);
  return {
    schemaVersion: 1,
    standardVersion: config.standardVersion,
    artifactSha256: config.artifactSha256,
    provider: { ...config.provider },
    collectedAt: new Date().toISOString(),
    probes: [a, b],
    stream,
    capacity,
  };
}

async function main(paths) {
  requireValue(paths.length === 1, "usage: node provider-runtime-collect.mjs CONFIG.json");
  const config = JSON.parse(fs.readFileSync(paths[0], "utf8"));
  process.stdout.write(`${JSON.stringify(await collectProviderRuntimeEvidence(config), null, 2)}\n`);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`EC-STREAM provider runtime collection failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
