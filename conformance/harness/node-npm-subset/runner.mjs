import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import diagnostics from "node:diagnostics_channel";
import { EventEmitter, once } from "node:events";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import querystring from "node:querystring";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import timers from "node:timers";
import timersPromises from "node:timers/promises";
import { fileURLToPath, domainToASCII, domainToUnicode } from "node:url";
import util from "node:util";
import zlib from "node:zlib";
import { BASELINE_DATE, BUILTIN_MODULES, FIXTURE_INSTALLED_OCTETS, FIXTURE_PACKAGES, IMPORT_CONDITIONS, NODE_BASELINE_VERSION, REQUIRE_CONDITIONS, capabilityLock, syntheticPackage } from "./fixture.mjs";
import { cacheKey, canonicalBuiltin, captureFailure, createProcessFacade, deriveProviderConfiguration, identity, resolveConditionalTarget, sanitizeRegistryUrl, sha512Integrity, transformCommonJs, validateApplicationSource, validateBuildInput, validateBuiltinImport, validateCapabilityLock, validatePackage } from "./reference-runtime.mjs";

const CASE_IDS = Array.from({ length: 15 }, (_, index) => `EC-NODE-T${String(index + 1).padStart(3, "0")}`);

function resolveStandardVersion(explicit) {
  if (explicit) return explicit;
  if (process.env.EDGE_CANON_STANDARD_VERSION) return process.env.EDGE_CANON_STANDARD_VERSION;
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: new URL("../../..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  return `edge-canon.next@${commit}`;
}

function record(id, data) {
  return { id, observedAt: new Date().toISOString(), data, evidenceRefs: [`local:node-npm-subset/${id}`] };
}

async function captureAsync(operation) {
  try { await operation(); return { settlement: "fulfill", name: null, code: null }; }
  catch (error) { return { settlement: "reject", name: error?.name ?? "Error", code: typeof error?.code === "string" ? error.code : null }; }
}

function packageGraph(count, octetsPerPackage) {
  const packages = [];
  const dependencies = {};
  const lockPackages = { "": { name: "edge-canon-capacity", version: "1.0.0" } };
  for (let index = 0; index < count; index += 1) {
    const bytes = new Uint8Array(octetsPerPackage).fill(index);
    const item = syntheticPackage(index, bytes, sha512Integrity(bytes));
    packages.push(item);
    dependencies[item.name] = item.version;
    lockPackages[`node_modules/${item.name}`] = { version: item.version, resolved: item.resolved, integrity: item.integrity };
  }
  return { manifest: { name: "edge-canon-capacity", version: "1.0.0", type: "module", dependencies }, lock: { name: "edge-canon-capacity", version: "1.0.0", lockfileVersion: 3, packages: lockPackages }, packages };
}

export async function runSuite(options = {}) {
  if (process.version !== NODE_BASELINE_VERSION) throw new Error(`EC-NODE requires ${NODE_BASELINE_VERSION}; observed ${process.version}`);
  const standardVersion = resolveStandardVersion(options.standardVersion);
  if (!/^edge-canon\.next@[0-9a-f]{40}$/.test(standardVersion)) throw new Error("an exact Edge Canon commit is required");
  const lock = capabilityLock(standardVersion);
  validateCapabilityLock(lock, standardVersion);
  const artifactSha256 = identity(lock);
  const cases = [];

  const inventory = [];
  for (const [specifier, exportNames] of Object.entries(BUILTIN_MODULES)) {
    const module = await import(specifier);
    inventory.push({ specifier, exports: exportNames, present: exportNames.filter((name) => name in module), missing: exportNames.filter((name) => !(name in module)) });
  }
  cases.push(record(CASE_IDS[0], {
    runtime: process.version,
    inventory,
    bareCanonical: canonicalBuiltin("path"),
    unsupportedBuiltin: captureFailure(() => validateBuiltinImport("node:child_process", ["spawn"])),
    unsupportedExport: captureFailure(() => validateBuiltinImport("node:path", ["madeUpExport"])),
  }));

  const original = Buffer.from("edge-canon", "utf8");
  const view = original.subarray(5);
  view[0] = 0x43;
  let assertionError;
  try { assert.deepStrictEqual({ value: 1 }, { value: 2 }); }
  catch (error) { assertionError = { name: error.name, code: error.code, actual: error.actual.value, expected: error.expected.value, operator: error.operator }; }
  await assert.rejects(Promise.reject(Object.assign(new Error("expected"), { code: "E_FIXTURE" })), { code: "E_FIXTURE" });
  cases.push(record(CASE_IDS[1], { utf8: original.toString("utf8"), hex: original.toString("hex"), viewAliases: original[5] === 0x43, assertionError }));

  const input = Buffer.from("edge-canon-node-24", "utf8");
  const digest = crypto.createHash("sha256").update(input).digest("hex");
  const hmac = crypto.createHmac("sha256", "fixed-key").update(input).digest("hex");
  const equalTiming = crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(digest));
  const unequalTiming = crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(digest.replace(/^./, digest[0] === "0" ? "1" : "0")));
  const compression = {};
  for (const [name, compress, decompress] of [
    ["gzip", zlib.gzipSync, zlib.gunzipSync], ["deflate", zlib.deflateSync, zlib.inflateSync], ["brotli", zlib.brotliCompressSync, zlib.brotliDecompressSync],
  ]) {
    const compressed = compress(input);
    compression[name] = { compressedOctets: compressed.byteLength, roundtrip: decompress(compressed).toString("utf8") };
  }
  cases.push(record(CASE_IDS[2], { digest, hmac, equalTiming, unequalTiming, compression }));

  const emitter = new EventEmitter();
  const eventTrace = [];
  emitter.on("value", (value) => eventTrace.push(`first-${value}`));
  emitter.on("value", (value) => eventTrace.push(`second-${value}`));
  const oncePromise = once(emitter, "once");
  emitter.emit("value", 7);
  emitter.emit("once", "only");
  const onceValue = await oncePromise;
  const channelName = `edge-canon.node.${standardVersion.slice(-12)}`;
  const channel = diagnostics.channel(channelName);
  const diagnosticTrace = [];
  const subscriber = (message, name) => diagnosticTrace.push({ message, name });
  channel.subscribe(subscriber);
  channel.publish({ value: 1 });
  channel.unsubscribe(subscriber);
  channel.publish({ value: 2 });
  cases.push(record(CASE_IDS[3], { eventTrace, onceValue, diagnosticTrace, hasSubscribersAfter: diagnostics.hasSubscribers(channelName) }));

  const pathValues = {
    posix: path.posix.normalize("/a//b/../c"),
    win32: path.win32.normalize("C:\\a\\b\\..\\c"),
    relative: path.posix.relative("/a/b", "/a/c/d"),
    parsed: path.posix.parse("/srv/app/index.mjs"),
  };
  const url = new URL("https://例え.テスト/a?x=1&x=2");
  const urlValues = { ascii: domainToASCII("例え.テスト"), unicode: domainToUnicode(url.hostname), params: url.searchParams.getAll("x") };
  const queryValues = { stringified: querystring.stringify({ a: "x y", b: ["1", "2"] }), parsed: querystring.parse("a=x%20y&b=1&b=2") };
  const utilValues = { formatted: util.format("%s:%d:%j", "value", 7, { ok: true }), stripped: util.stripVTControlCharacters("\u001b[31mred\u001b[0m"), inspected: util.inspect({ b: 2, a: 1 }, { sorted: true }) };
  cases.push(record(CASE_IDS[4], { pathValues, urlValues, queryValues, utilValues }));

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
  const streamError = await captureAsync(() => pipeline(Readable.from([Buffer.from("x")]), new Transform({ transform(_chunk, _encoding, callback) { callback(Object.assign(new Error("stream-sentinel"), { code: "E_STREAM_FIXTURE" })); } }), new Writable({ write(_chunk, _encoding, callback) { callback(); } })));
  cases.push(record(CASE_IDS[5], { decoded, streamed, streamTrace, streamError }));

  const scheduleOrder = await new Promise((resolve) => {
    timers.setImmediate(() => {
      const order = ["callback"];
      process.nextTick(() => order.push("nextTick"));
      Promise.resolve().then(() => order.push("promise"));
      timers.setImmediate(() => { order.push("immediate"); resolve(order); });
    });
  });
  const als = new AsyncLocalStorage();
  async function contextProbe(label, wait) {
    return als.run({ label }, async () => {
      const values = [als.getStore().label];
      await Promise.resolve(); values.push(als.getStore().label);
      await new Promise((resolve) => process.nextTick(() => { values.push(als.getStore().label); resolve(); }));
      await timersPromises.setTimeout(wait); values.push(als.getStore().label);
      const localEmitter = new EventEmitter();
      localEmitter.on("check", () => values.push(als.getStore().label));
      localEmitter.emit("check");
      return values;
    });
  }
  const [contextA, contextB] = await Promise.all([contextProbe("A", 2), contextProbe("B", 1)]);
  const exitLifecycle = als.run({ label: "outer" }, () => {
    const exited = als.exit((left, right) => ({ store: als.getStore() ?? null, sum: left + right }), 2, 3);
    return { exited, restored: als.getStore().label };
  });
  const storeAfterRun = als.getStore() ?? null;
  cases.push(record(CASE_IDS[6], {
    scheduleOrder,
    contexts: { A: contextA, B: contextB },
    exitLifecycle,
    storeAfterRun,
  }));

  const exportsMap = { "edge-canon": "./edge.mjs", worker: "./worker.mjs", browser: "./browser.mjs", import: "./import.mjs", require: "./require.cjs", default: "./default.mjs" };
  cases.push(record(CASE_IDS[7], {
    importTarget: resolveConditionalTarget(exportsMap, IMPORT_CONDITIONS),
    requireTarget: resolveConditionalTarget(exportsMap, REQUIRE_CONDITIONS),
    fallbackTarget: resolveConditionalTarget({ default: "./default.mjs" }, IMPORT_CONDITIONS),
    canonicalBuiltin: validateBuiltinImport("events", ["EventEmitter"]),
    moduleTypes: { root: "module", esm: "module", cjs: "commonjs" },
  }));

  const commonJsSource = "module.exports = { value: 42 };";
  const esmArtifact = transformCommonJs(commonJsSource);
  const evaluated = await import(`data:text/javascript,${encodeURIComponent(esmArtifact)}`);
  cases.push(record(CASE_IDS[8], { defaultValue: evaluated.default, staticEsm: /export default/.test(esmArtifact), runtimeRequireReferences: (esmArtifact.match(/\brequire\s*\(/g) ?? []).length, artifactSha256: identity(esmArtifact) }));

  const deterministicGraph = packageGraph(2, 64);
  const buildA = validateBuildInput(deterministicGraph.manifest, deterministicGraph.lock, deterministicGraph.packages);
  const buildB = validateBuildInput(deterministicGraph.manifest, structuredClone(deterministicGraph.lock), [...deterministicGraph.packages].reverse());
  const missingLock = captureFailure(() => validateBuildInput(deterministicGraph.manifest, null, deterministicGraph.packages));
  const oldLock = structuredClone(deterministicGraph.lock); oldLock.lockfileVersion = 2;
  const oldLockFailure = captureFailure(() => validateBuildInput(deterministicGraph.manifest, oldLock, deterministicGraph.packages));
  const mismatch = structuredClone(deterministicGraph.lock); mismatch.packages[`node_modules/${deterministicGraph.packages[0].name}`].version = "2.0.0";
  const mismatchFailure = captureFailure(() => validateBuildInput(deterministicGraph.manifest, mismatch, deterministicGraph.packages));
  const missingIntegrityPackage = { ...deterministicGraph.packages[0], integrity: null };
  const missingIntegrity = captureFailure(() => validatePackage(missingIntegrityPackage));
  const changedPackage = { ...deterministicGraph.packages[0], bytes: Uint8Array.from([9, 9, 9]) };
  const changedIntegrity = captureFailure(() => validatePackage(changedPackage));
  cases.push(record(CASE_IDS[9], { identities: [buildA.graphIdentity, buildB.graphIdentity], packageCounts: [buildA.packageCount, buildB.packageCount], failures: { missingLock, oldLock: oldLockFailure, mismatch: mismatchFailure, missingIntegrity, changedIntegrity } }));

  const negativeBytes = Uint8Array.from([1]);
  const basePackage = syntheticPackage(99, negativeBytes, sha512Integrity(negativeBytes));
  const sourceFailures = {
    dynamicRequire: captureFailure(() => validateApplicationSource("const value = require(name);")),
    dynamicImport: captureFailure(() => validateApplicationSource("await import(name);")),
    childProcess: captureFailure(() => validateApplicationSource("import { spawn } from 'node:child_process';")),
  };
  const packageFailures = {
    installHook: captureFailure(() => validatePackage({ ...basePackage, scripts: { postinstall: "node build.js" } })),
    nativeAddon: captureFailure(() => validatePackage({ ...basePackage, files: ["index.mjs", "binding.node"] })),
  };
  cases.push(record(CASE_IDS[10], { sourceFailures, packageFailures, applicationExecutions: 0, hookExecutions: 0, nativeHandles: 0 }));

  const processA = createProcessFacade({ TENANT: "A", SHARED: "initial" });
  const processB = createProcessFacade({ TENANT: "B", SHARED: "initial" });
  processA.env.SHARED = "changed-a";
  const selectedPath = processA.getBuiltinModule("path");
  const selectedUrl = processA.getBuiltinModule("node:url");
  cases.push(record(CASE_IDS[11], {
    version: processA.version,
    nodeVersion: processA.versions.node,
    platform: processA.platform,
    env: { A: { ...processA.env }, B: { ...processB.env } },
    visibleFields: Object.keys(processA).sort(),
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
      unsupportedIsUndefined: processA.getBuiltinModule("fs") === undefined,
    },
  }));

  const credentialUrl = "https://token-user:secret-pass@registry.example.invalid/@scope/pkg/-/pkg-1.0.0.tgz";
  const sanitized = sanitizeRegistryUrl(credentialUrl);
  const unsafe = {
    traversal: captureFailure(() => validatePackage({ ...basePackage, files: ["../escape"] })),
    absolute: captureFailure(() => validatePackage({ ...basePackage, files: ["/etc/passwd"] })),
    device: captureFailure(() => validatePackage({ ...basePackage, files: ["CON"] })),
    collision: captureFailure(() => validatePackage({ ...basePackage, files: ["A.js", "a.js"] })),
  };
  cases.push(record(CASE_IDS[12], { sanitized, credentialLeaked: sanitized.includes("token-user") || sanitized.includes("secret-pass"), unsafe, cache: { same: cacheKey(basePackage) === cacheKey({ ...basePackage }), transformerDiffers: cacheKey(basePackage) !== cacheKey(basePackage, "ec-cjs-2") } }));

  const capacityGraph = packageGraph(FIXTURE_PACKAGES, FIXTURE_INSTALLED_OCTETS / FIXTURE_PACKAGES);
  const capacity = validateBuildInput(capacityGraph.manifest, capacityGraph.lock, capacityGraph.packages);
  const faultPoints = ["fetch", "verify", "transform", "commit"].map((point) => ({ point, activeBefore: "deployment-old", activeAfter: "deployment-old", partialCommitted: false, verifiedCacheEntries: 0 }));
  cases.push(record(CASE_IDS[13], { packageCount: capacity.packageCount, installedOctets: capacity.installedOctets, graphIdentity: capacity.graphIdentity, faultPoints, runtimeMissingModule: { code: "EC_NODE_ARTIFACT_INCOMPLETE", status: 500, repairAttempts: 0, hostFallbacks: 0 } }));

  const mutations = [];
  for (const [variant, mutate] of [
    ["higher-major", (value) => { value.schemaVersion = 2; }],
    ["floating-standard", (value) => { value.standardVersion = "edge-canon.next@main"; }],
    ["node-baseline", (value) => { value.node.semanticBaseline = "25.0.0"; }],
    ["extra-export", (value) => { value.node.builtinModules["node:path"].push("madeUpExport"); }],
    ["condition-order", (value) => { value.modules.importConditions.reverse(); }],
    ["lock-policy", (value) => { value.npm.lockfile = "package-lock.json@4-required"; }],
    ["unknown-field", (value) => { value.provider = "cloudflare"; }],
  ]) {
    const candidate = structuredClone(lock); mutate(candidate);
    mutations.push({ variant, code: captureFailure(() => validateCapabilityLock(candidate, standardVersion)), applicationExecutions: 0 });
  }
  cases.push(record(CASE_IDS[14], { baselineDate: BASELINE_DATE, mutations, providers: ["cloudflare-workers-pages", "tencent-edgeone-makers", "deislet"].map((provider) => deriveProviderConfiguration(lock, provider)) }));

  return {
    schemaVersion: 1,
    standardId: "edge-canon.next",
    suiteId: "EC-NODE",
    backend: { id: "edge-canon-reference-node", implementationVersion: "edge-canon-reference-node-harness/1", standardVersion },
    artifactSha256,
    cases,
  };
}

async function main(outputPath, standardVersion) {
  const document = await runSuite({ standardVersion });
  const output = `${JSON.stringify(document, null, 2)}\n`;
  if (outputPath) { const fs = await import("node:fs"); fs.writeFileSync(outputPath, output); }
  else process.stdout.write(output);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main(process.argv[2], process.argv[3]).catch((error) => { process.stderr.write(`EC-NODE runner failed: ${error.stack ?? error.message}\n`); process.exitCode = 1; });
}
