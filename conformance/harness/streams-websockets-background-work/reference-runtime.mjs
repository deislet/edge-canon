const EXACT_STANDARD = /^edge-canon\.next@[0-9a-f]{40}$/;

export class StreamContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StreamContractError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new StreamContractError(code, message);
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(code, "invalid object");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) reject(code, "unknown or missing field");
}

export function validateCapabilityLock(value, expectedStandardVersion) {
  exactKeys(value, ["schemaVersion", "format", "standardVersion", "baselineDate", "streams", "backgroundWork", "webSockets", "limits", "providerExtensions"], "EC_STREAM_DOCUMENT_INVALID");
  if (value.schemaVersion !== 1 || value.format !== "edge-canon.streams-websockets-background-work/v1") reject("EC_STREAM_VERSION_UNSUPPORTED", "unsupported capability lock format");
  if (!EXACT_STANDARD.test(value.standardVersion)) reject("EC_STREAM_STANDARD_PIN_INVALID", "exact standard commit required");
  if (value.standardVersion !== expectedStandardVersion) reject("EC_STREAM_STANDARD_MISMATCH", "standard commit mismatch");
  if (value.baselineDate !== "2026-09-04") reject("EC_STREAM_BASELINE_UNSUPPORTED", "unsupported upstream baseline");

  exactKeys(value.streams, ["readable", "writable", "transform", "body", "chunkType"], "EC_STREAM_DOCUMENT_INVALID");
  const streams = {
    readable: "whatwg-selected-instance-subset",
    writable: "whatwg-selected-instance-subset",
    transform: "identity-only",
    body: "request-response-byte-stream",
    chunkType: "Uint8Array",
  };
  for (const [key, expected] of Object.entries(streams)) {
    if (value.streams[key] !== expected) reject("EC_STREAM_API_SET_INVALID", "unsupported stream API set");
  }

  exactKeys(value.backgroundWork, ["api", "settlement", "reliability"], "EC_STREAM_DOCUMENT_INVALID");
  const backgroundWork = {
    api: "context-wait-until",
    settlement: "all-settled-independent",
    reliability: "best-effort-no-retry",
  };
  for (const [key, expected] of Object.entries(backgroundWork)) {
    if (value.backgroundWork[key] !== expected) reject("EC_STREAM_BACKGROUND_POLICY_INVALID", "unsupported background work policy");
  }

  exactKeys(value.webSockets, ["portability", "sourcePolicy", "excludedGlobals", "globalIsolation"], "EC_STREAM_DOCUMENT_INVALID");
  if (value.webSockets.portability !== "unavailable-in-reference-intersection"
      || value.webSockets.sourcePolicy !== "reject-before-deploy"
      || JSON.stringify(value.webSockets.excludedGlobals) !== JSON.stringify(["WebSocket", "WebSocketPair", "WebSocketServer"])
      || value.webSockets.globalIsolation !== "sealed-undefined-before-module-evaluation") {
    reject("EC_STREAM_WEBSOCKET_POLICY_INVALID", "WebSocket portability policy differs");
  }
  exactKeys(value.limits, ["streamedOctets", "fixtureChunkOctets"], "EC_STREAM_DOCUMENT_INVALID");
  if (value.limits.streamedOctets !== 65_536 || value.limits.fixtureChunkOctets !== 4_096) reject("EC_STREAM_LIMIT_SET_INVALID", "unsupported stream boundary");
  if (value.providerExtensions !== "non-portable") reject("EC_STREAM_EXTENSION_POLICY_INVALID", "provider extension policy differs");
  return value;
}

export function deriveProviderConfiguration(lock, providerId) {
  validateCapabilityLock(lock, lock.standardVersion);
  const common = {
    providerId,
    transform: "identity-byte-shim",
    waitUntil: "context-bound-all-settled",
    webSocket: "reject-nonportable",
    providerGlobalIsolation: "sealed-undefined-before-module-evaluation",
  };
  if (providerId === "cloudflare-workers-pages") return { ...common, nativeTransform: "IdentityTransformStream-or-compatible" };
  if (providerId === "tencent-edgeone-makers") return { ...common, nativeTransform: "TransformStream-no-arguments" };
  if (providerId === "deislet") return { ...common, nativeTransform: "edge-canon-runtime" };
  reject("EC_STREAM_PROVIDER_UNKNOWN", "unknown provider");
}

export function createIdentityTransform() {
  return new TransformStream({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array)) {
        const error = new TypeError("standard stream chunks must be Uint8Array");
        error.code = "EC_STREAM_CHUNK_TYPE";
        throw error;
      }
      controller.enqueue(chunk);
    },
  });
}

export function validateApplicationSource(source, dependencySources = [], analysis) {
  if (typeof source !== "string" || !Array.isArray(dependencySources) || dependencySources.some((item) => typeof item !== "string")) {
    reject("EC_STREAM_SOURCE_INVALID", "source and dependencies must be strings");
  }
  exactKeys(analysis, ["providerGlobals", "directStreamConstructors", "transformersWithArguments"], "EC_STREAM_SOURCE_INVALID");
  if (!Array.isArray(analysis.providerGlobals) || analysis.providerGlobals.some((name) => !["WebSocket", "WebSocketPair", "WebSocketServer"].includes(name))) {
    reject("EC_STREAM_SOURCE_INVALID", "providerGlobals must contain only scope-resolved WebSocket global names");
  }
  if (!Array.isArray(analysis.directStreamConstructors) || analysis.directStreamConstructors.some((name) => !["ReadableStream", "WritableStream"].includes(name))) {
    reject("EC_STREAM_SOURCE_INVALID", "directStreamConstructors contains an unknown constructor");
  }
  if (!Number.isSafeInteger(analysis.transformersWithArguments) || analysis.transformersWithArguments < 0) {
    reject("EC_STREAM_SOURCE_INVALID", "transformersWithArguments must be a non-negative integer");
  }
  if (analysis.providerGlobals.length > 0) reject("EC_STREAM_WEBSOCKET_NONPORTABLE", "WebSocket is not in the portable reference intersection");
  if (analysis.directStreamConstructors.length > 0) reject("EC_STREAM_DIRECT_CONSTRUCTOR_NONPORTABLE", "direct stream constructors are not portable in v1");
  if (analysis.transformersWithArguments > 0) reject("EC_STREAM_TRANSFORMER_NONPORTABLE", "TransformStream arguments are not portable in v1");
  return { applicationGlobals: ["TransformStream"], providerGlobals: [] };
}

export function isolateProviderGlobals(target) {
  if ((typeof target !== "object" || target === null) && typeof target !== "function") {
    reject("EC_STREAM_PROVIDER_GLOBAL_EXPOSED", "provider global target must be an object");
  }
  for (const name of ["WebSocket", "WebSocketPair", "WebSocketServer"]) {
    try {
      Object.defineProperty(target, name, {
        value: undefined,
        writable: false,
        enumerable: false,
        configurable: false,
      });
    } catch {
      reject("EC_STREAM_PROVIDER_GLOBAL_EXPOSED", `provider global ${name} could not be isolated`);
    }
  }
  return ["WebSocket", "WebSocketPair", "WebSocketServer"].map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    return {
      name,
      type: typeof target[name],
      owned: descriptor !== undefined,
      writable: descriptor?.writable,
      enumerable: descriptor?.enumerable,
      configurable: descriptor?.configurable,
    };
  });
}

function waitUntilError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

export function createInvocationContext() {
  let state = "foreground-open";
  const tasks = [];
  const context = {
    waitUntil(task) {
      if (state !== "foreground-open") throw waitUntilError("EC_WAIT_UNTIL_CLOSED", "waitUntil lifecycle is closed");
      if (!task || (typeof task !== "object" && typeof task !== "function") || typeof task.then !== "function") {
        throw waitUntilError("EC_WAIT_UNTIL_PROMISE_REQUIRED", "waitUntil requires a Promise or thenable");
      }
      const tracked = { settled: false, result: null };
      tracked.promise = Promise.resolve(task).then(
        (value) => { tracked.settled = true; tracked.result = { status: "fulfilled", value }; return tracked.result; },
        (error) => { tracked.settled = true; tracked.result = { status: "rejected", reasonName: error?.name ?? "Error" }; return tracked.result; },
      );
      tasks.push(tracked);
    },
    async closeForeground() {
      if (state !== "foreground-open") throw waitUntilError("EC_WAIT_UNTIL_CLOSED", "invocation lifecycle is already closed");
      state = "background-active";
      const results = await Promise.all(tasks.map((task) => task.promise));
      state = "closed";
      return results;
    },
    abandon() {
      if (state === "closed") return 0;
      state = "closed";
      return tasks.filter((task) => !task.settled).length;
    },
    get state() { return state; },
    get registeredCount() { return tasks.length; },
  };
  return context;
}

export function captureContractFailure(value, expectedStandardVersion) {
  try {
    validateCapabilityLock(value, expectedStandardVersion);
    return null;
  } catch (error) {
    if (!(error instanceof StreamContractError)) throw error;
    return error.code;
  }
}

export function captureSourceFailure(source, dependencySources = [], analysis) {
  try {
    validateApplicationSource(source, dependencySources, analysis);
    return null;
  } catch (error) {
    if (!(error instanceof StreamContractError)) throw error;
    return error.code;
  }
}
