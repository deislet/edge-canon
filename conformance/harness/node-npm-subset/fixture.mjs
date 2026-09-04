export const NODE_BASELINE = "24.20.0";
export const NODE_BASELINE_VERSION = `v${NODE_BASELINE}`;
export const BASELINE_DATE = "2026-09-04";
export const FIXTURE_PACKAGES = 16;
export const FIXTURE_INSTALLED_OCTETS = 1_048_576;

export const BUILTIN_MODULES = Object.freeze({
  "node:assert": ["AssertionError", "deepEqual", "deepStrictEqual", "doesNotMatch", "doesNotReject", "doesNotThrow", "equal", "fail", "ifError", "match", "notDeepEqual", "notDeepStrictEqual", "notEqual", "notStrictEqual", "ok", "rejects", "strictEqual", "throws"],
  "node:assert/strict": ["AssertionError", "deepEqual", "deepStrictEqual", "doesNotMatch", "doesNotReject", "doesNotThrow", "equal", "fail", "ifError", "match", "notDeepEqual", "notDeepStrictEqual", "notEqual", "notStrictEqual", "ok", "rejects", "strictEqual", "throws"],
  "node:async_hooks": ["AsyncLocalStorage"],
  "node:buffer": ["Buffer"],
  "node:crypto": ["createHash", "createHmac", "randomBytes", "randomUUID", "timingSafeEqual", "webcrypto"],
  "node:diagnostics_channel": ["channel", "hasSubscribers"],
  "node:events": ["EventEmitter", "once"],
  "node:path": ["basename", "delimiter", "dirname", "extname", "format", "isAbsolute", "join", "normalize", "parse", "posix", "relative", "resolve", "sep", "toNamespacedPath", "win32"],
  "node:process": ["env", "getBuiltinModule", "nextTick", "platform", "version", "versions"],
  "node:querystring": ["decode", "encode", "escape", "parse", "stringify", "unescape"],
  "node:stream": ["Duplex", "PassThrough", "Readable", "Transform", "Writable", "finished", "pipeline"],
  "node:stream/promises": ["finished", "pipeline"],
  "node:string_decoder": ["StringDecoder"],
  "node:timers": ["clearImmediate", "clearInterval", "clearTimeout", "setImmediate", "setInterval", "setTimeout"],
  "node:timers/promises": ["setTimeout"],
  "node:url": ["URL", "URLSearchParams", "domainToASCII", "domainToUnicode", "fileURLToPath", "pathToFileURL", "urlToHttpOptions"],
  "node:util": ["callbackify", "format", "formatWithOptions", "inherits", "inspect", "promisify", "stripVTControlCharacters"],
  "node:zlib": ["brotliCompressSync", "brotliDecompressSync", "constants", "deflateSync", "gzipSync", "gunzipSync", "inflateSync"],
});

export const GLOBALS = Object.freeze(["Buffer", "process", "setImmediate", "clearImmediate"]);
export const IMPORT_CONDITIONS = Object.freeze(["edge-canon", "worker", "browser", "import", "default"]);
export const REQUIRE_CONDITIONS = Object.freeze(["edge-canon", "worker", "browser", "require", "default"]);

export function capabilityLock(standardVersion) {
  return {
    schemaVersion: 1,
    format: "edge-canon.node-npm/v1",
    standardVersion,
    baselineDate: BASELINE_DATE,
    node: {
      semanticBaseline: NODE_BASELINE,
      handlerModel: "edge-canon-fetch-context",
      builtinModules: BUILTIN_MODULES,
      globals: GLOBALS,
      unsupportedBuiltins: "reject-before-deploy",
    },
    modules: {
      artifact: "esm-static-graph",
      builtinSpecifier: "node-colon-canonical-bare-alias-accepted",
      commonJs: "resolve-and-transform-at-build",
      dynamicResolution: "reject-unless-statically-enumerated",
      importConditions: IMPORT_CONDITIONS,
      requireConditions: REQUIRE_CONDITIONS,
    },
    npm: {
      manifest: "package.json-selected-fields",
      lockfile: "package-lock.json@3-required",
      registries: "public-and-authenticated-private-build-only",
      integrity: "sha512-required-for-registry-packages",
      lifecycleScripts: "dependency-install-hooks-rejected",
      nativeAddons: "rejected",
      runtimeInstall: "forbidden",
    },
    limits: { fixturePackages: FIXTURE_PACKAGES, fixtureInstalledOctets: FIXTURE_INSTALLED_OCTETS },
    providerExtensions: "non-portable",
  };
}

export function syntheticPackage(index, bytes, integrity) {
  const name = `@edge-canon/fixture-${String(index).padStart(2, "0")}`;
  return {
    name,
    version: "1.0.0",
    resolved: `https://registry.example.invalid/${name}/-/${name.split("/")[1]}-1.0.0.tgz`,
    integrity,
    bytes,
    files: ["index.mjs"],
    exports: { ".": { "edge-canon": "./index.mjs", default: "./fallback.mjs" } },
  };
}
