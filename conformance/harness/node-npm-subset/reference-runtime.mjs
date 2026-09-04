import crypto from "node:crypto";
import process from "node:process";
import { BASELINE_DATE, BUILTIN_MODULES, FIXTURE_INSTALLED_OCTETS, FIXTURE_PACKAGES, GLOBALS, IMPORT_CONDITIONS, NODE_BASELINE, REQUIRE_CONDITIONS } from "./fixture.mjs";

const EXACT_STANDARD = /^edge-canon\.next@[0-9a-f]{40}$/;
const SELECTED_MANIFEST_FIELDS = new Set(["name", "version", "type", "dependencies", "optionalDependencies", "peerDependencies", "exports", "imports"]);
const INSTALL_HOOKS = new Set(["preinstall", "install", "postinstall"]);

export class NodeContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NodeContractError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new NodeContractError(code, message);
}

function exactKeys(value, expected, code = "EC_NODE_DOCUMENT_INVALID") {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(code, "invalid object");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) reject(code, "unknown or missing field");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha512Integrity(value) {
  return `sha512-${crypto.createHash("sha512").update(value).digest("base64")}`;
}

export function identity(value) {
  return sha256(Buffer.from(JSON.stringify(canonical(value)), "utf8"));
}

export function validateCapabilityLock(value, expectedStandardVersion) {
  exactKeys(value, ["schemaVersion", "format", "standardVersion", "baselineDate", "node", "modules", "npm", "limits", "providerExtensions"]);
  if (value.schemaVersion !== 1 || value.format !== "edge-canon.node-npm/v1") reject("EC_NODE_VERSION_UNSUPPORTED", "unsupported capability lock format");
  if (!EXACT_STANDARD.test(value.standardVersion)) reject("EC_NODE_STANDARD_PIN_INVALID", "exact standard commit required");
  if (value.standardVersion !== expectedStandardVersion) reject("EC_NODE_STANDARD_MISMATCH", "standard commit mismatch");
  if (value.baselineDate !== BASELINE_DATE || value.node?.semanticBaseline !== NODE_BASELINE) reject("EC_NODE_BASELINE_UNSUPPORTED", "unsupported Node semantic baseline");

  exactKeys(value.node, ["semanticBaseline", "handlerModel", "builtinModules", "globals", "unsupportedBuiltins"]);
  if (value.node.handlerModel !== "edge-canon-fetch-context" || value.node.unsupportedBuiltins !== "reject-before-deploy") reject("EC_NODE_API_SET_INVALID", "invalid Node application surface");
  if (JSON.stringify(value.node.builtinModules) !== JSON.stringify(BUILTIN_MODULES) || JSON.stringify(value.node.globals) !== JSON.stringify(GLOBALS)) reject("EC_NODE_API_SET_INVALID", "builtin/export inventory differs");

  exactKeys(value.modules, ["artifact", "builtinSpecifier", "commonJs", "dynamicResolution", "importConditions", "requireConditions"]);
  if (value.modules.artifact !== "esm-static-graph" || value.modules.builtinSpecifier !== "node-colon-canonical-bare-alias-accepted" || value.modules.commonJs !== "resolve-and-transform-at-build" || value.modules.dynamicResolution !== "reject-unless-statically-enumerated") reject("EC_NODE_MODULE_POLICY_INVALID", "module policy differs");
  if (JSON.stringify(value.modules.importConditions) !== JSON.stringify(IMPORT_CONDITIONS) || JSON.stringify(value.modules.requireConditions) !== JSON.stringify(REQUIRE_CONDITIONS)) reject("EC_NODE_CONDITIONS_INVALID", "condition order differs");

  exactKeys(value.npm, ["manifest", "lockfile", "registries", "integrity", "lifecycleScripts", "nativeAddons", "runtimeInstall"]);
  const npmPolicy = {
    manifest: "package.json-selected-fields",
    lockfile: "package-lock.json@3-required",
    registries: "public-and-authenticated-private-build-only",
    integrity: "sha512-required-for-registry-packages",
    lifecycleScripts: "dependency-install-hooks-rejected",
    nativeAddons: "rejected",
    runtimeInstall: "forbidden",
  };
  for (const [key, expected] of Object.entries(npmPolicy)) if (value.npm[key] !== expected) reject("EC_NPM_POLICY_INVALID", "npm policy differs");
  exactKeys(value.limits, ["fixturePackages", "fixtureInstalledOctets"]);
  if (value.limits.fixturePackages !== FIXTURE_PACKAGES || value.limits.fixtureInstalledOctets !== FIXTURE_INSTALLED_OCTETS) reject("EC_NODE_LIMIT_SET_INVALID", "Node/npm boundary differs");
  if (value.providerExtensions !== "non-portable") reject("EC_NODE_EXTENSION_POLICY_INVALID", "provider extensions are not portable");
  return value;
}

export function canonicalBuiltin(specifier) {
  const canonicalName = specifier.startsWith("node:") ? specifier : `node:${specifier}`;
  if (!(canonicalName in BUILTIN_MODULES)) reject("EC_NODE_BUILTIN_UNSUPPORTED", `unsupported builtin ${specifier}`);
  return canonicalName;
}

export function validateBuiltinImport(specifier, exports) {
  const canonicalName = canonicalBuiltin(specifier);
  if (!Array.isArray(exports) || exports.some((value) => typeof value !== "string")) reject("EC_NODE_SOURCE_INVALID", "exports must be string names");
  const allowed = new Set(BUILTIN_MODULES[canonicalName]);
  for (const name of exports) if (!allowed.has(name)) reject("EC_NODE_EXPORT_UNSUPPORTED", `${canonicalName} does not expose ${name}`);
  return canonicalName;
}

export function validateApplicationSource(source) {
  if (typeof source !== "string") reject("EC_NODE_SOURCE_INVALID", "source must be text");
  if (/\b(?:child_process|cluster|worker_threads)\b/.test(source)) reject("EC_NODE_BUILTIN_UNSUPPORTED", "host-control builtin is excluded");
  if (/\brequire\s*\(\s*(?!["'])/.test(source) || /\bimport\s*\(\s*(?!["'])/.test(source)) reject("EC_NPM_DYNAMIC_RESOLUTION_UNSUPPORTED", "dynamic module resolution is not enumerable");
  return true;
}

function pathIsUnsafe(path) {
  return typeof path !== "string" || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).some((part) => part === "..") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(path.split(/[\\/]/).at(-1) ?? "");
}

export function validatePackage(packageRecord) {
  if (!packageRecord || typeof packageRecord !== "object") reject("EC_NPM_PACKAGE_UNRESOLVED", "package record is absent");
  if (!packageRecord.name || !packageRecord.version || !packageRecord.resolved) reject("EC_NPM_PACKAGE_UNRESOLVED", "package identity is incomplete");
  if (typeof packageRecord.integrity !== "string" || !packageRecord.integrity.startsWith("sha512-")) reject("EC_NPM_INTEGRITY_REQUIRED", "registry package needs sha512 integrity");
  if (!(packageRecord.bytes instanceof Uint8Array)) reject("EC_NPM_PACKAGE_UNRESOLVED", "package bytes are absent");
  if (sha512Integrity(packageRecord.bytes) !== packageRecord.integrity) reject("EC_NPM_INTEGRITY_FAILED", "package bytes differ from lock");
  for (const hook of Object.keys(packageRecord.scripts ?? {})) if (INSTALL_HOOKS.has(hook)) reject("EC_NPM_LIFECYCLE_SCRIPT_UNSUPPORTED", `dependency hook ${hook} is not executed`);
  for (const path of packageRecord.files ?? []) {
    if (pathIsUnsafe(path)) reject("EC_NPM_ARCHIVE_PATH_UNSAFE", "package path escapes its root");
    if (path.endsWith(".node")) reject("EC_NPM_NATIVE_ADDON_UNSUPPORTED", "native addon is not portable");
  }
  const folded = new Set();
  for (const path of packageRecord.files ?? []) {
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (folded.has(key)) reject("EC_NPM_ARCHIVE_PATH_COLLISION", "package paths collide across filesystems");
    folded.add(key);
  }
  return packageRecord;
}

export function resolveConditionalTarget(exportsValue, conditions) {
  if (typeof exportsValue === "string") {
    if (!exportsValue.startsWith("./") || pathIsUnsafe(exportsValue.slice(2))) reject("EC_NPM_EXPORT_TARGET_UNSAFE", "exports target escapes package root");
    return exportsValue;
  }
  if (!exportsValue || typeof exportsValue !== "object" || Array.isArray(exportsValue)) reject("EC_NPM_PACKAGE_UNRESOLVED", "invalid conditional exports");
  // Node's package contract gives the package object's key order semantic
  // weight. `conditions` is the canonical active set carried by the lock; it
  // must not be used to reorder the package author's object.
  for (const [condition, target] of Object.entries(exportsValue)) {
    if (condition === "default" || conditions.includes(condition)) {
      return resolveConditionalTarget(target, conditions);
    }
  }
  reject("EC_NPM_PACKAGE_UNRESOLVED", "no matching export condition");
}

export function validateBuildInput(manifest, lock, packages) {
  if (!lock) reject("EC_NPM_LOCK_REQUIRED", "package-lock.json is required");
  if (lock.lockfileVersion !== 3) reject("EC_NPM_LOCK_VERSION_UNSUPPORTED", "lockfileVersion 3 is required");
  if (!manifest || typeof manifest !== "object") reject("EC_NPM_LOCK_MISMATCH", "manifest is invalid");
  const selectedManifest = Object.fromEntries(Object.entries(manifest).filter(([key]) => SELECTED_MANIFEST_FIELDS.has(key)));
  const requested = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) };
  for (const [name, version] of Object.entries(requested)) {
    const locked = lock.packages?.[`node_modules/${name}`];
    if (!locked || locked.version !== version) reject("EC_NPM_LOCK_MISMATCH", `${name} differs between manifest and lock`);
  }
  const validated = packages.map(validatePackage).sort((left, right) => left.name.localeCompare(right.name));
  return {
    selectedManifest,
    packageCount: validated.length,
    installedOctets: validated.reduce((sum, item) => sum + item.bytes.byteLength, 0),
    graphIdentity: identity(validated.map(({ name, version, resolved, integrity, files, exports: exportMap }) => ({ name, version, resolved: sanitizeRegistryUrl(resolved), integrity, files: [...files].sort(), exports: exportMap }))),
  };
}

export function transformCommonJs(source) {
  validateApplicationSource(source);
  if (/module\.exports\s*=/.test(source)) return source.replace(/module\.exports\s*=\s*/, "const __default = ") + "\nexport default __default;\n";
  reject("EC_NPM_COMMONJS_TRANSFORM_UNSUPPORTED", "fixture transformer only accepts a static module.exports assignment");
}

export function sanitizeRegistryUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.toString();
}

export function cacheKey(packageRecord, transformerVersion = "ec-cjs-1") {
  return identity({ name: packageRecord.name, version: packageRecord.version, integrity: packageRecord.integrity, baseline: NODE_BASELINE, conditions: IMPORT_CONDITIONS, transformerVersion, policy: "edge-canon.node-npm/v1" });
}

export function createProcessFacade(environment = {}) {
  const env = Object.assign(Object.create(null), environment);
  return Object.freeze({ env, getBuiltinModule(name) { return canonicalBuiltin(name); }, nextTick: process.nextTick.bind(process), platform: "linux", version: `v${NODE_BASELINE}`, versions: Object.freeze({ node: NODE_BASELINE }) });
}

export function deriveProviderConfiguration(lock, providerId) {
  validateCapabilityLock(lock, lock.standardVersion);
  const common = { providerId, nodeSemanticBaseline: NODE_BASELINE, handlerModel: "edge-canon-fetch-context", surfaceIdentity: identity(lock.node.builtinModules), npm: "locked-build-only", unsupported: "reject-before-deploy" };
  if (providerId === "cloudflare-workers-pages") return { ...common, executor: "workers-native-plus-verified-shims", compatibilityDateFloor: "2026-08-04" };
  if (providerId === "tencent-edgeone-makers") return { ...common, executor: "cloud-functions-api-node", output: "cloud-functions/api-node" };
  if (providerId === "deislet") return { ...common, executor: "deislet-node-compat-layer" };
  reject("EC_NODE_PROVIDER_UNKNOWN", "unknown provider");
}

export function captureFailure(operation) {
  try { operation(); return null; } catch (error) { if (!(error instanceof NodeContractError)) throw error; return error.code; }
}
