import { deepStrictEqual, rejects } from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { channel, hasSubscribers } from "node:diagnostics_channel";
import { EventEmitter, once } from "node:events";
import { posix, win32 } from "node:path";
import { env as importedEnv, getBuiltinModule, nextTick, platform, version, versions } from "node:process";
import { parse as parseQuery, stringify as stringifyQuery } from "node:querystring";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as nodeSetImmediate } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { domainToASCII, domainToUnicode, fileURLToPath, pathToFileURL } from "node:url";
import { format as formatValue, inspect, stripVTControlCharacters } from "node:util";
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gzipSync,
  gunzipSync,
  inflateSync,
} from "node:zlib";

import { BUILTIN_MODULES } from "./fixture.mjs";

function record(id, data) {
  return { id, data };
}

function runtimeInventory() {
  return Object.entries(BUILTIN_MODULES).map(([specifier, exports]) => {
    const module = getBuiltinModule(specifier);
    return {
      specifier,
      exports,
      present: module === undefined ? [] : exports.filter((name) => name in module),
      missing: module === undefined ? exports : exports.filter((name) => !(name in module)),
      visible: module === undefined ? [] : Object.keys(module).sort(),
    };
  });
}

async function bufferAndAssert() {
  const original = Buffer.from("edge-canon", "utf8");
  const view = original.subarray(5);
  view[0] = 0x43;
  let assertionError;
  try {
    deepStrictEqual({ value: 1 }, { value: 2 });
  } catch (error) {
    assertionError = {
      name: error.name,
      code: error.code,
      actual: error.actual.value,
      expected: error.expected.value,
      operator: error.operator,
    };
  }
  await rejects(Promise.reject(Object.assign(new Error("expected"), { code: "E_FIXTURE" })), { code: "E_FIXTURE" });
  return { utf8: original.toString("utf8"), hex: original.toString("hex"), viewAliases: original[5] === 0x43, assertionError };
}

function cryptoAndCompression() {
  const input = Buffer.from("edge-canon-node-24", "utf8");
  const digest = createHash("sha256").update(input).digest("hex");
  const hmac = createHmac("sha256", "fixed-key").update(input).digest("hex");
  const unequal = digest.replace(/^./, digest[0] === "0" ? "1" : "0");
  const compression = {};
  for (const [name, compress, decompress] of [
    ["gzip", gzipSync, gunzipSync],
    ["deflate", deflateSync, inflateSync],
    ["brotli", brotliCompressSync, brotliDecompressSync],
  ]) {
    const compressed = compress(input);
    compression[name] = { compressedOctets: compressed.byteLength, roundtrip: decompress(compressed).toString("utf8") };
  }
  return {
    digest,
    hmac,
    equalTiming: timingSafeEqual(Buffer.from(digest), Buffer.from(digest)),
    unequalTiming: timingSafeEqual(Buffer.from(digest), Buffer.from(unequal)),
    compression,
  };
}

async function eventsAndDiagnostics(label) {
  const emitter = new EventEmitter();
  const eventTrace = [];
  emitter.on("value", (value) => eventTrace.push(`first-${value}`));
  emitter.on("value", (value) => eventTrace.push(`second-${value}`));
  const oncePromise = once(emitter, "once");
  emitter.emit("value", 7);
  emitter.emit("once", "only");
  const onceValue = await oncePromise;
  const channelName = `edge-canon.node.provider.${label}`;
  const diagnosticChannel = channel(channelName);
  const diagnosticTrace = [];
  const subscriber = (message, name) => diagnosticTrace.push({ message, name });
  diagnosticChannel.subscribe(subscriber);
  diagnosticChannel.publish({ value: 1 });
  diagnosticChannel.unsubscribe(subscriber);
  diagnosticChannel.publish({ value: 2 });
  return { eventTrace, onceValue, diagnosticTrace, hasSubscribersAfter: hasSubscribers(channelName) };
}

function pathsUrlsQueryAndUtil() {
  const fixedUrl = new URL("https://例え.テスト/a?x=1&x=2");
  return {
    pathValues: {
      posix: posix.normalize("/a//b/../c"),
      win32: win32.normalize("C:\\a\\b\\..\\c"),
      relative: posix.relative("/a/b", "/a/c/d"),
      parsed: posix.parse("/srv/app/index.mjs"),
    },
    urlValues: {
      ascii: domainToASCII("例え.テスト"),
      unicode: domainToUnicode(fixedUrl.hostname),
      params: fixedUrl.searchParams.getAll("x"),
    },
    queryValues: {
      stringified: stringifyQuery({ a: "x y", b: ["1", "2"] }),
      parsed: parseQuery("a=x%20y&b=1&b=2"),
    },
    utilValues: {
      formatted: formatValue("%s:%d:%j", "value", 7, { ok: true }),
      stripped: stripVTControlCharacters("\u001b[31mred\u001b[0m"),
      inspected: inspect({ b: 2, a: 1 }, { sorted: true }),
    },
  };
}

async function decoderAndStreams() {
  const decoder = new StringDecoder("utf8");
  const emoji = Buffer.from("A😀B", "utf8");
  const decoded = decoder.write(emoji.subarray(0, 3)) + decoder.write(emoji.subarray(3, 5)) + decoder.end(emoji.subarray(5));
  const streamed = [];
  const streamTrace = [];
  await pipeline(
    Readable.from([Buffer.from("edge"), Buffer.from("canon")]),
    new Transform({ transform(chunk, _encoding, callback) { streamTrace.push(`transform-${chunk.toString()}`); callback(null, Buffer.from(chunk.toString().toUpperCase())); } }),
    new Writable({ write(chunk, _encoding, callback) { streamed.push(chunk.toString()); streamTrace.push(`write-${chunk.toString()}`); callback(); } }),
  );
  let streamError;
  try {
    await pipeline(
      Readable.from([Buffer.from("x")]),
      new Transform({ transform(_chunk, _encoding, callback) { callback(Object.assign(new Error("stream-sentinel"), { code: "E_STREAM_FIXTURE" })); } }),
      new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    );
  } catch (error) {
    streamError = { settlement: "reject", name: error.name, code: error.code };
  }
  return { decoded, streamed, streamTrace, streamError };
}

async function schedulingAndStorage() {
  const scheduleOrder = await new Promise((resolveOrder) => {
    nodeSetImmediate(() => {
      const order = ["callback"];
      nextTick(() => order.push("nextTick"));
      Promise.resolve().then(() => order.push("promise"));
      nodeSetImmediate(() => { order.push("immediate"); resolveOrder(order); });
    });
  });
  const storage = new AsyncLocalStorage();
  async function probe(label, delay) {
    return storage.run({ label }, async () => {
      const values = [storage.getStore().label];
      await Promise.resolve();
      values.push(storage.getStore().label);
      await new Promise((done) => nextTick(() => { values.push(storage.getStore().label); done(); }));
      await sleep(delay);
      values.push(storage.getStore().label);
      const emitter = new EventEmitter();
      emitter.on("check", () => values.push(storage.getStore().label));
      emitter.emit("check");
      return values;
    });
  }
  const [contextA, contextB] = await Promise.all([probe("A", 2), probe("B", 1)]);
  const exitLifecycle = storage.run({ label: "outer" }, () => {
    const exited = storage.exit((left, right) => ({ store: storage.getStore() ?? null, sum: left + right }), 2, 3);
    return { exited, restored: storage.getStore().label };
  });
  const storeAfterRun = storage.getStore() ?? null;
  return {
    scheduleOrder,
    contexts: { A: contextA, B: contextB },
    exitLifecycle,
    storeAfterRun,
  };
}

async function processInvocation(label) {
  const before = importedEnv.SHARED;
  importedEnv.TENANT = label;
  if (label === "A") importedEnv.SHARED = "changed-a";
  await sleep(label === "A" ? 25 : 5);
  const selectedPath = getBuiltinModule("path");
  const selectedUrl = getBuiltinModule("node:url");
  return {
    label,
    before,
    environment: { TENANT: importedEnv.TENANT, SHARED: importedEnv.SHARED },
    version,
    nodeVersion: versions.node,
    platform,
    visibleFields: Object.keys(process).sort(),
    hostFieldsHidden: [process.pid, process.argv, process.cwd].every((value) => value === undefined),
    builtin: {
      pathJoin: selectedPath.join("edge", "canon"),
      pathResolve: selectedPath.resolve("edge", "canon"),
      posixResolve: selectedPath.posix.resolve("edge", "canon"),
      win32Resolve: selectedPath.win32.resolve("edge", "canon"),
      pathFields: Object.keys(selectedPath).sort(),
      relativeFileUrl: selectedUrl.pathToFileURL("asset #%.txt").href,
      posixFilePath: selectedUrl.fileURLToPath("file:///asset%20space.txt"),
      windowsFilePath: selectedUrl.fileURLToPath("file:///C:/asset%20space.txt", { windows: true }),
      urlFields: Object.keys(selectedUrl).sort(),
      unsupportedIsUndefined: getBuiltinModule("fs") === undefined,
    },
  };
}

export default async function handler({ request }) {
  const url = new URL(request.url);
  const label = url.searchParams.get("label") === "B" ? "B" : "A";
  const cases = [
    record("EC-NODE-T001", { inventory: runtimeInventory() }),
    record("EC-NODE-T002", await bufferAndAssert()),
    record("EC-NODE-T003", cryptoAndCompression()),
    record("EC-NODE-T004", await eventsAndDiagnostics(label)),
    record("EC-NODE-T005", pathsUrlsQueryAndUtil()),
    record("EC-NODE-T006", await decoderAndStreams()),
    record("EC-NODE-T007", await schedulingAndStorage()),
  ];
  const invocation = await processInvocation(label);
  return Response.json({ schemaVersion: 1, suiteId: "EC-NODE", label, cases, invocation });
}
