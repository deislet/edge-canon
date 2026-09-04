import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const NativeTransformStream = globalThis.TransformStream;

function typedError(code, message) {
  const error = new TypeError(message);
  Object.defineProperty(error, "code", { value: code, enumerable: false });
  return error;
}

function PortableTransformStream(...args) {
  if (!new.target) throw new TypeError("TransformStream must be constructed");
  if (args.length !== 0) throw typedError("EC_STREAM_TRANSFORMER_NONPORTABLE", "configured TransformStream is outside Edge Canon");
  const stream = new NativeTransformStream();
  const nativeGetWriter = stream.writable.getWriter.bind(stream.writable);
  Object.defineProperty(stream.writable, "getWriter", {
    value() {
      const writer = nativeGetWriter();
      const nativeWrite = writer.write.bind(writer);
      Object.defineProperty(writer, "write", {
        value(chunk) {
          if (!(chunk instanceof Uint8Array)) {
            return Promise.reject(typedError("EC_STREAM_CHUNK_TYPE", "stream chunks must be Uint8Array"));
          }
          return nativeWrite(chunk);
        },
      });
      return writer;
    },
  });
  return stream;
}

PortableTransformStream.prototype = NativeTransformStream.prototype;
Object.defineProperty(NativeTransformStream.prototype, "constructor", {
  value: PortableTransformStream,
  writable: false,
  enumerable: false,
  configurable: false,
});
Object.defineProperty(globalThis, "TransformStream", {
  value: PortableTransformStream,
  writable: false,
  enumerable: false,
  configurable: false,
});
for (const name of ["WebSocket", "WebSocketPair", "WebSocketServer"]) {
  Object.defineProperty(globalThis, name, {
    value: undefined,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

const { default: handler } = await import("./provider-runtime-fixture.mjs");
const { verifyProviderRuntimeEvidence } = await import("./provider-runtime-oracle.mjs");

function context() {
  const tasks = [];
  return {
    tasks,
    value: {
      waitUntil(promise) {
        tasks.push(Promise.resolve(promise));
      },
    },
  };
}

async function probe(label) {
  const invocation = context();
  const response = await handler({
    request: new Request(`https://fixture.invalid/?label=${label}`),
    ...invocation.value,
  });
  await Promise.allSettled(invocation.tasks);
  return response.json();
}

async function streamEvidence() {
  const response = await handler({ request: new Request("https://fixture.invalid/stream"), ...context().value });
  let bodyEnded = false;
  const headersBeforeBodyEnd = response.headers.get("x-edge-canon-case") === "EC-STREAM-T006" && !bodyEnded;
  const body = new Uint8Array(await response.arrayBuffer()).map((value) => value);
  bodyEnded = true;
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    caseHeader: response.headers.get("x-edge-canon-case"),
    body: [...body],
    headersBeforeBodyEnd,
    replacementResponses: 0,
  };
}

async function capacityEvidence() {
  const response = await handler({ request: new Request("https://fixture.invalid/capacity"), ...context().value });
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    caseHeader: response.headers.get("x-edge-canon-case"),
    bodyOctets: body.byteLength,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    declaredChunkOctets: Number(response.headers.get("x-edge-canon-chunk-octets")),
    declaredTotalOctets: Number(response.headers.get("x-edge-canon-total-octets")),
  };
}

async function evidence() {
  const [a, b, stream, capacity] = await Promise.all([
    probe("A"), probe("B"), streamEvidence(), capacityEvidence(),
  ]);
  return {
    schemaVersion: 1,
    standardVersion: "edge-canon.next@0123456789abcdef0123456789abcdef01234567",
    artifactSha256: "0".repeat(64),
    provider: { id: "test-runtime", implementationVersion: process.version, deploymentId: "local-test-process" },
    probes: [a, b],
    stream,
    capacity,
  };
}

test("the provider runtime oracle accepts the normalized EC-STREAM runtime subset", async () => {
  const value = await evidence();
  const result = verifyProviderRuntimeEvidence(value);
  assert.equal(result.status, "runtime-partial-pass");
  assert.deepEqual(result.verifiedAssertions, [
    "EC-STREAM-T001",
    "EC-STREAM-T002",
    "EC-STREAM-T003/order-and-lock-release",
    "EC-STREAM-T004",
    "EC-STREAM-T006/streamed-response",
    "EC-STREAM-T009/stream-canary",
    "EC-STREAM-T010",
    "EC-STREAM-T011/runtime-byte-and-global-isolation",
  ]);
  assert.ok(result.remainingAssertions.includes("EC-STREAM-T007/waitUntil-all-settled"));
});

test("the provider runtime oracle rejects a cross-invocation stream canary", async () => {
  const value = await evidence();
  value.probes.find(({ label }) => label === "B").caseData["EC-STREAM-T009"].body = [[0xaa]];
  assert.throws(() => verifyProviderRuntimeEvidence(value), /B T009 stream canary differs/);
});

test("the provider runtime oracle rejects a reflectively reachable provider global", async () => {
  const value = await evidence();
  value.probes[0].caseData["EC-STREAM-T011"].providerGlobals[0].type = "function";
  assert.throws(() => verifyProviderRuntimeEvidence(value), /provider global remains reflectively reachable/);
});

test("the provider runtime fixture stays inside the portable source surface", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./provider-runtime-fixture.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /\bnew\s+(?:ReadableStream|WritableStream)\b/);
  assert.doesNotMatch(source, /\bnew\s+TransformStream\s*\([^)]\S/);
  assert.doesNotMatch(source, /\bnew\s+(?:WebSocket|WebSocketPair|WebSocketServer)\b/);
  assert.doesNotMatch(source, /\b(?:require|import)\s*\(/);
  assert.doesNotMatch(source, /^\s*import\s/m);
});
