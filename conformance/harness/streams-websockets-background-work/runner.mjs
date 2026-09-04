import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIXTURE_CHUNK_OCTETS, STREAM_BASELINE_DATE, STREAM_CHUNKS, STREAMED_OCTETS, capabilityLock } from "./fixture.mjs";
import {
  captureContractFailure,
  captureSourceFailure,
  createIdentityTransform,
  createInvocationContext,
  deriveProviderConfiguration,
  isolateProviderGlobals,
  validateApplicationSource,
  validateCapabilityLock,
} from "./reference-runtime.mjs";

const CASE_IDS = Array.from({ length: 13 }, (_, index) => `EC-STREAM-T${String(index + 1).padStart(3, "0")}`);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function identity(value) {
  return sha256(Buffer.from(JSON.stringify(stable(value)), "utf8"));
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
  return { id, observedAt: new Date().toISOString(), data, evidenceRefs: [`local:streams-websockets-background-work/${id}`] };
}

function captureSync(operation) {
  try {
    operation();
    return { settlement: "return", name: null, code: null };
  } catch (error) {
    const code = typeof error?.code === "string" && error.code.startsWith("EC_") ? error.code : null;
    return { settlement: "throw", name: error?.name ?? error?.constructor?.name ?? "Error", code };
  }
}

async function captureAsync(operation) {
  try {
    await operation();
    return { settlement: "fulfill", name: null, code: null };
  } catch (error) {
    const code = typeof error?.code === "string" && error.code.startsWith("EC_") ? error.code : null;
    return { settlement: "reject", name: error?.name ?? error?.constructor?.name ?? "Error", code };
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readChunks(readable, pauseMilliseconds = 0) {
  const reader = readable.getReader();
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return { chunks, terminal: { done, value: value ?? null } };
      chunks.push([...value]);
      if (pauseMilliseconds) await delay(pauseMilliseconds);
    }
  } finally {
    reader.releaseLock();
  }
}

async function writeChunks(writable, chunks) {
  const writer = writable.getWriter();
  try {
    for (const chunk of chunks) await writer.write(chunk);
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

export async function runSuite(options = {}) {
  const standardVersion = resolveStandardVersion(options.standardVersion);
  if (!/^edge-canon\.next@[0-9a-f]{40}$/.test(standardVersion)) throw new Error("an exact Edge Canon commit is required");
  const lock = capabilityLock(standardVersion);
  validateCapabilityLock(lock, standardVersion);
  const artifactSha256 = identity(lock);
  const cases = [];

  const identityStream = createIdentityTransform();
  const identityRead = readChunks(identityStream.readable);
  await writeChunks(identityStream.writable, STREAM_CHUNKS);
  const identityResult = await identityRead;
  cases.push(record(CASE_IDS[0], {
    chunks: identityResult.chunks,
    expectedChunks: STREAM_CHUNKS.map((value) => [...value]),
    terminal: identityResult.terminal,
    locksAfterRelease: { readable: identityStream.readable.locked, writable: identityStream.writable.locked },
  }));

  const lockStream = createIdentityTransform();
  const firstReader = lockStream.readable.getReader();
  const readableLocked = lockStream.readable.locked;
  const secondReader = captureSync(() => lockStream.readable.getReader());
  firstReader.releaseLock();
  const replacementReader = lockStream.readable.getReader();
  const oldReaderRead = await captureAsync(() => firstReader.read());
  replacementReader.releaseLock();
  const firstWriter = lockStream.writable.getWriter();
  const writableLocked = lockStream.writable.locked;
  const secondWriter = captureSync(() => lockStream.writable.getWriter());
  firstWriter.releaseLock();
  const replacementWriter = lockStream.writable.getWriter();
  const oldWriterWrite = await captureAsync(() => firstWriter.write(new Uint8Array([1])));
  replacementWriter.releaseLock();
  cases.push(record(CASE_IDS[1], {
    readableLocked, writableLocked, secondReader, secondWriter, oldReaderRead, oldWriterWrite,
    locksAfterRelease: { readable: lockStream.readable.locked, writable: lockStream.writable.locked },
  }));

  const pipeTrace = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  const pipeSource = new ReadableStream({
    start(controller) {
      for (const value of [1, 2, 3]) controller.enqueue(new Uint8Array([value]));
      controller.close();
    },
  });
  const pipeSink = new WritableStream({
    async write(chunk) {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      pipeTrace.push(`start-${chunk[0]}`);
      await delay(3);
      pipeTrace.push(`end-${chunk[0]}`);
      inFlight -= 1;
    },
    close() { pipeTrace.push("close"); },
  });
  const pipeResult = await captureAsync(() => pipeSource.pipeTo(pipeSink));
  cases.push(record(CASE_IDS[2], { pipeTrace, maximumInFlight, pipeResult, locksAfterPipe: { readable: pipeSource.locked, writable: pipeSink.locked } }));

  const teeSource = new ReadableStream({
    start(controller) {
      for (const value of [7, 8, 9]) controller.enqueue(new Uint8Array([value]));
      controller.close();
    },
  });
  const [left, right] = teeSource.tee();
  const leftResultPromise = readChunks(left, 2);
  const rightResultPromise = readChunks(right);
  const [leftResult, rightResult] = await Promise.all([leftResultPromise, rightResultPromise]);
  cases.push(record(CASE_IDS[3], {
    left: leftResult.chunks, right: rightResult.chunks,
    streamsDistinct: left !== right,
    locksAfterRelease: { left: left.locked, right: right.locked },
  }));

  let errorController;
  const errored = new ReadableStream({ start(controller) { errorController = controller; } });
  const errorReader = errored.getReader();
  const closedResultPromise = captureAsync(() => errorReader.closed);
  const firstReadPromise = errorReader.read();
  errorController.enqueue(new Uint8Array([42]));
  const partial = await firstReadPromise;
  errorController.error(new Error("source-sentinel"));
  const secondRead = await captureAsync(() => errorReader.read());
  const readerClosed = await closedResultPromise;
  errorReader.releaseLock();
  let cancelReason = null;
  let cancelCount = 0;
  const cancellable = new ReadableStream({ cancel(reason) { cancelReason = reason; cancelCount += 1; } });
  await cancellable.cancel("consumer-stop");
  let abortReason = null;
  let abortCount = 0;
  const abortable = new WritableStream({ abort(reason) { abortReason = reason; abortCount += 1; } });
  await abortable.abort("producer-stop");
  cases.push(record(CASE_IDS[4], {
    partial: [...partial.value], secondRead, readerClosed,
    cancel: { reason: cancelReason, count: cancelCount }, abort: { reason: abortReason, count: abortCount },
  }));

  const lifecycleEvents = ["handler-settled"];
  const responseStream = createIdentityTransform();
  const response = new Response(responseStream.readable, { status: 200 });
  const responseRead = (async () => {
    const value = await response.arrayBuffer();
    lifecycleEvents.push("body-closed");
    return new Uint8Array(value);
  })();
  const responseWrite = (async () => {
    const writer = responseStream.writable.getWriter();
    await delay(2);
    await writer.write(new Uint8Array([1, 2]));
    lifecycleEvents.push("chunk-one");
    await delay(2);
    await writer.write(new Uint8Array([3, 4]));
    lifecycleEvents.push("chunk-two");
    await writer.close();
    writer.releaseLock();
  })();
  const [responseBody] = await Promise.all([responseRead, responseWrite]);
  let committedController;
  const committedBody = new ReadableStream({ start(controller) { committedController = controller; } });
  const committedResponse = new Response(committedBody, { status: 200 });
  const committedReader = committedResponse.body.getReader();
  const committedFirst = committedReader.read();
  committedController.enqueue(new Uint8Array([9]));
  await committedFirst;
  committedController.error(new Error("committed-sentinel"));
  const committedTerminal = await captureAsync(() => committedReader.read());
  committedReader.releaseLock();
  cases.push(record(CASE_IDS[5], {
    events: lifecycleEvents, body: [...responseBody], status: response.status,
    committed: { status: committedResponse.status, terminal: committedTerminal, replacementResponses: 0 },
  }));

  const background = createInvocationContext();
  const completionOrder = [];
  background.waitUntil(delay(5).then(() => { completionOrder.push("first"); return "first-value"; }));
  background.waitUntil(delay(1).then(() => { completionOrder.push("second-rejected"); throw new Error("background-sentinel"); }));
  background.waitUntil(delay(3).then(() => { completionOrder.push("third"); return "third-value"; }));
  const backgroundResults = await background.closeForeground();
  cases.push(record(CASE_IDS[6], { completionOrder, results: backgroundResults, response: "response-stable", state: background.state }));

  const invalidContext = createInvocationContext();
  const invalidPromise = captureSync(() => invalidContext.waitUntil(7));
  await invalidContext.closeForeground();
  let lateExecutions = 0;
  const lateThenable = { then(resolve) { lateExecutions += 1; resolve(); } };
  const closedRegistration = captureSync(() => invalidContext.waitUntil(lateThenable));
  cases.push(record(CASE_IDS[7], { invalidPromise, closedRegistration, lateExecutions, state: invalidContext.state }));

  const contextA = createInvocationContext();
  const contextB = createInvocationContext();
  contextA.waitUntil(Promise.resolve("task-a"));
  contextB.waitUntil(Promise.resolve("task-b"));
  const streamA = createIdentityTransform();
  const streamB = createIdentityTransform();
  const readA = readChunks(streamA.readable);
  const readB = readChunks(streamB.readable);
  await Promise.all([
    writeChunks(streamA.writable, [new Uint8Array([0xaa])]),
    writeChunks(streamB.writable, [new Uint8Array([0xbb])]),
  ]);
  const [bodyA, bodyB, tasksA, tasksB] = await Promise.all([readA, readB, contextA.closeForeground(), contextB.closeForeground()]);
  cases.push(record(CASE_IDS[8], {
    bodies: [bodyA.chunks, bodyB.chunks], tasks: [tasksA, tasksB],
    identities: { contextsDistinct: contextA !== contextB, streamsDistinct: streamA.readable !== streamB.readable },
  }));

  const capacityStream = createIdentityTransform();
  const capacityRead = (async () => {
    const result = await new Response(capacityStream.readable).arrayBuffer();
    return new Uint8Array(result);
  })();
  const capacityWriter = capacityStream.writable.getWriter();
  let outstandingWrites = 0;
  let maximumOutstandingWrites = 0;
  let maximumChunk = 0;
  for (let offset = 0; offset < STREAMED_OCTETS; offset += FIXTURE_CHUNK_OCTETS) {
    const chunk = new Uint8Array(FIXTURE_CHUNK_OCTETS).fill((offset / FIXTURE_CHUNK_OCTETS) & 0xff);
    maximumChunk = Math.max(maximumChunk, chunk.byteLength);
    outstandingWrites += 1;
    maximumOutstandingWrites = Math.max(maximumOutstandingWrites, outstandingWrites);
    await capacityWriter.write(chunk);
    outstandingWrites -= 1;
  }
  await capacityWriter.close();
  capacityWriter.releaseLock();
  const capacityBody = await capacityRead;
  cases.push(record(CASE_IDS[9], {
    length: capacityBody.byteLength, sha256: sha256(capacityBody),
    expectedSha256: "d1c4808f4915c05b0d32202151b6c8813fbc083ebf1846f0ab0f8df0fe31006e",
    maximumChunk, maximumOutstandingWrites,
  }));

  const chunkFailures = [];
  for (const [variant, chunk] of [["string", "not-bytes"], ["object", { value: 1 }]]) {
    const value = createIdentityTransform();
    const readerFailure = captureAsync(async () => {
      const reader = value.readable.getReader();
      try { await reader.read(); } finally { reader.releaseLock(); }
    });
    const writer = value.writable.getWriter();
    const result = await captureAsync(() => writer.write(chunk));
    await readerFailure;
    chunkFailures.push({ variant, ...result });
  }
  const emptyAnalysis = { providerGlobals: [], directStreamConstructors: [], transformersWithArguments: 0 };
  const sourceFailures = [
    { variant: "websocket", code: captureSourceFailure("const socket = new WebSocket(url);", [], { ...emptyAnalysis, providerGlobals: ["WebSocket"] }) },
    { variant: "websocket-pair-dependency", code: captureSourceFailure("export default handler", ["new WebSocketPair()"], { ...emptyAnalysis, providerGlobals: ["WebSocketPair"] }) },
    { variant: "websocket-server", code: captureSourceFailure("self.WebSocketServer", [], { ...emptyAnalysis, providerGlobals: ["WebSocketServer"] }) },
    { variant: "readable-constructor", code: captureSourceFailure("new ReadableStream({ start() {} })", [], { ...emptyAnalysis, directStreamConstructors: ["ReadableStream"] }) },
    { variant: "transformer", code: captureSourceFailure("new TransformStream({ transform() {} })", [], { ...emptyAnalysis, transformersWithArguments: 1 }) },
  ];
  const allowedSurface = validateApplicationSource("const { readable, writable } = new TransformStream(); export { readable, writable };", [], emptyAnalysis);
  const providerPrototype = { WebSocket() {}, WebSocketPair() {}, WebSocketServer() {} };
  const isolatedGlobal = isolateProviderGlobals(Object.create(providerPrototype));
  cases.push(record(CASE_IDS[10], { chunkFailures, sourceFailures, allowedSurface, isolatedGlobal }));

  let attempts = 0;
  const noRetry = createInvocationContext();
  noRetry.waitUntil(Promise.resolve().then(() => { attempts += 1; throw new Error("no-retry-sentinel"); }));
  const noRetryResults = await noRetry.closeForeground();
  const abandoned = createInvocationContext();
  abandoned.waitUntil(new Promise(() => {}));
  const lostTasks = abandoned.abandon();
  await delay(1);
  cases.push(record(CASE_IDS[11], {
    attempts, retries: 0, results: noRetryResults, lostTasks,
    response: "response-stable", abandonedState: abandoned.state,
  }));

  const mutations = [];
  for (const [variant, mutate] of [
    ["higher-major", (value) => { value.schemaVersion = 2; }],
    ["floating-standard", (value) => { value.standardVersion = "edge-canon.next@main"; }],
    ["unknown-field", (value) => { value.vendor = "cloudflare"; }],
    ["websocket-enabled", (value) => { value.webSockets.portability = "required"; }],
    ["websocket-global-exposed", (value) => { value.webSockets.globalIsolation = "provider-native"; }],
  ]) {
    const value = structuredClone(lock);
    mutate(value);
    mutations.push({ variant, code: captureContractFailure(value, standardVersion), applicationExecutions: 0 });
  }
  cases.push(record(CASE_IDS[12], {
    baselineDate: STREAM_BASELINE_DATE,
    mutations,
    providers: ["cloudflare-workers-pages", "tencent-edgeone-makers", "deislet"].map((provider) => deriveProviderConfiguration(lock, provider)),
  }));

  return {
    schemaVersion: 1,
    standardId: "edge-canon.next",
    suiteId: "EC-STREAM",
    backend: { id: "edge-canon-reference-stream", implementationVersion: "edge-canon-reference-stream-harness/1", standardVersion },
    artifactSha256,
    cases,
  };
}

async function main(outputPath, standardVersion) {
  const document = await runSuite({ standardVersion });
  const output = `${JSON.stringify(document, null, 2)}\n`;
  if (outputPath) {
    const fs = await import("node:fs");
    fs.writeFileSync(outputPath, output);
  } else process.stdout.write(output);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main(process.argv[2], process.argv[3]).catch((error) => {
    process.stderr.write(`EC-STREAM runner failed: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
