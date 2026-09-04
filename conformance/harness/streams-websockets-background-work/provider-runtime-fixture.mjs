const CASE_IDS = {
  identity: "EC-STREAM-T001",
  locks: "EC-STREAM-T002",
  pipe: "EC-STREAM-T003",
  tee: "EC-STREAM-T004",
  concurrent: "EC-STREAM-T009",
  invalid: "EC-STREAM-T011",
};

const IDENTITY_CHUNKS = [
  Uint8Array.from([101, 100, 103, 101]),
  Uint8Array.from([45, 99, 97, 110, 111, 110]),
  Uint8Array.from([45, 115, 116, 114, 101, 97, 109]),
];

function captureSync(operation) {
  try {
    operation();
    return { settlement: "return", name: null, code: null };
  } catch (error) {
    return { settlement: "throw", name: error?.name ?? "Error", code: error?.code ?? null };
  }
}

async function captureAsync(operation) {
  try {
    await operation();
    return { settlement: "fulfill", name: null, code: null };
  } catch (error) {
    return { settlement: "reject", name: error?.name ?? "Error", code: error?.code ?? null };
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readChunks(readable) {
  const reader = readable.getReader();
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return { chunks, terminal: { done, value: value ?? null } };
      chunks.push([...value]);
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

async function identityCase() {
  const stream = new TransformStream();
  const read = readChunks(stream.readable);
  await writeChunks(stream.writable, IDENTITY_CHUNKS);
  const result = await read;
  return {
    chunks: result.chunks,
    expectedChunks: IDENTITY_CHUNKS.map((chunk) => [...chunk]),
    terminal: result.terminal,
    locksAfterRelease: { readable: stream.readable.locked, writable: stream.writable.locked },
  };
}

async function lockCase() {
  const stream = new TransformStream();
  const firstReader = stream.readable.getReader();
  const readableLocked = stream.readable.locked;
  const secondReader = captureSync(() => stream.readable.getReader());
  firstReader.releaseLock();
  const replacementReader = stream.readable.getReader();
  const oldReaderRead = await captureAsync(() => firstReader.read());
  replacementReader.releaseLock();
  const firstWriter = stream.writable.getWriter();
  const writableLocked = stream.writable.locked;
  const secondWriter = captureSync(() => stream.writable.getWriter());
  firstWriter.releaseLock();
  const replacementWriter = stream.writable.getWriter();
  const oldWriterWrite = await captureAsync(() => firstWriter.write(new Uint8Array([1])));
  replacementWriter.releaseLock();
  return {
    readableLocked,
    writableLocked,
    secondReader,
    secondWriter,
    oldReaderRead,
    oldWriterWrite,
    locksAfterRelease: { readable: stream.readable.locked, writable: stream.writable.locked },
  };
}

async function pipeCase() {
  const source = new TransformStream();
  const sink = new TransformStream();
  const output = readChunks(sink.readable);
  const pipeResult = captureAsync(() => source.readable.pipeTo(sink.writable));
  await writeChunks(source.writable, [
    new Uint8Array([1]),
    new Uint8Array([2]),
    new Uint8Array([3]),
  ]);
  return {
    chunks: (await output).chunks,
    pipeResult: await pipeResult,
    locksAfterPipe: { readable: source.readable.locked, writable: sink.writable.locked },
  };
}

async function teeCase() {
  const source = new TransformStream();
  const [left, right] = source.readable.tee();
  const leftResult = readChunks(left);
  const rightResult = readChunks(right);
  await writeChunks(source.writable, [
    new Uint8Array([7]),
    new Uint8Array([8]),
    new Uint8Array([9]),
  ]);
  const [leftValue, rightValue] = await Promise.all([leftResult, rightResult]);
  return {
    left: leftValue.chunks,
    right: rightValue.chunks,
    streamsDistinct: left !== right,
    locksAfterRelease: { left: left.locked, right: right.locked },
  };
}

async function invocationCase(label, context) {
  const stream = new TransformStream();
  const read = readChunks(stream.readable);
  const canary = label === "B" ? 0xbb : 0xaa;
  await writeChunks(stream.writable, [new Uint8Array([canary])]);
  const waitUntilPresent = typeof context?.waitUntil === "function";
  const waitUntilReturnedUndefined = waitUntilPresent
    ? context.waitUntil(Promise.resolve(`task-${label}`)) === undefined
    : false;
  return { body: (await read).chunks, waitUntilPresent, waitUntilReturnedUndefined };
}

async function invalidCase() {
  const chunkFailures = [];
  for (const [variant, chunk] of [["string", "not-bytes"], ["object", { value: 1 }]]) {
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    chunkFailures.push({ variant, ...(await captureAsync(() => writer.write(chunk))) });
    writer.releaseLock();
  }
  const configuredTransform = captureSync(() => Reflect.construct(TransformStream, [{ transform() {} }]));
  const transformDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TransformStream");
  const providerGlobals = ["WebSocket", "WebSocketPair", "WebSocketServer"].map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    return {
      name,
      type: typeof globalThis[name],
      owned: descriptor !== undefined,
      writable: descriptor?.writable,
      enumerable: descriptor?.enumerable,
      configurable: descriptor?.configurable,
    };
  });
  return {
    chunkFailures,
    configuredTransform,
    providerGlobals,
    transformDescriptor: {
      writable: transformDescriptor?.writable,
      enumerable: transformDescriptor?.enumerable,
      configurable: transformDescriptor?.configurable,
    },
    constructorClosed: TransformStream.prototype.constructor === TransformStream,
    functionPrototypeClosed: Object.getPrototypeOf(TransformStream) === Function.prototype,
  };
}

async function probe(label, context) {
  const caseData = {
    [CASE_IDS.identity]: await identityCase(),
    [CASE_IDS.locks]: await lockCase(),
    [CASE_IDS.pipe]: await pipeCase(),
    [CASE_IDS.tee]: await teeCase(),
    [CASE_IDS.concurrent]: await invocationCase(label, context),
    [CASE_IDS.invalid]: await invalidCase(),
  };
  return Response.json({ schemaVersion: 1, suiteId: "EC-STREAM", label, caseData });
}

function streamingResponse() {
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  void (async () => {
    await delay(25);
    await writer.write(new Uint8Array([1, 2]));
    await delay(50);
    await writer.write(new Uint8Array([3, 4]));
    await writer.close();
    writer.releaseLock();
  })();
  return new Response(stream.readable, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "x-edge-canon-case": "EC-STREAM-T006",
    },
  });
}

function capacityResponse() {
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  void (async () => {
    for (let index = 0; index < 16; index += 1) {
      await writer.write(new Uint8Array(4_096).fill(index));
    }
    await writer.close();
    writer.releaseLock();
  })();
  return new Response(stream.readable, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "x-edge-canon-case": "EC-STREAM-T010",
      "x-edge-canon-chunk-octets": "4096",
      "x-edge-canon-total-octets": "65536",
    },
  });
}

export default async function handler({ request, context }) {
  const url = new URL(request.url);
  if (url.pathname === "/stream") return streamingResponse();
  if (url.pathname === "/capacity") return capacityResponse();
  const label = url.searchParams.get("label") === "B" ? "B" : "A";
  return probe(label, context);
}
