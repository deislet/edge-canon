import { canonicalBytes, configRevision, documentIdentity, stableValue } from "./fixture.mjs";

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const EXACT_STANDARD = /^edge-canon\.next@[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export class EnvironmentError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "EnvironmentError";
    this.code = code;
  }
}

function fail(code) {
  throw new EnvironmentError(code);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, required, code) {
  if (!object(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) fail(code);
}

function wellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("EC_ENV_VALUE_INVALID");
    return;
  }
  if (typeof value === "string") {
    if (!wellFormedString(value)) fail("EC_ENV_VALUE_INVALID");
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) fail("EC_ENV_VALUE_INVALID");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validateJsonValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("EC_ENV_VALUE_INVALID");
    for (const [key, item] of Object.entries(value)) {
      if (!wellFormedString(key)) fail("EC_ENV_VALUE_INVALID");
      validateJsonValue(item, seen);
    }
  }
  seen.delete(value);
}

function canonicalJsonBytes(value) {
  if (typeof value === "string" || value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    fail("EC_ENV_VALUE_INVALID");
  }
  validateJsonValue(value);
  let encoded;
  try {
    encoded = canonicalBytes(value);
  } catch {
    fail("EC_ENV_VALUE_INVALID");
  }
  return encoded;
}

function valueBytes(value, valueType) {
  if (valueType === "string") {
    if (typeof value !== "string" || !wellFormedString(value)) fail("EC_ENV_VALUE_INVALID");
    return Buffer.byteLength(value, "utf8");
  }
  return canonicalJsonBytes(value).byteLength;
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (object(value)) {
    const clone = Object.create(null);
    for (const key of Object.keys(value)) clone[key] = cloneJson(value[key]);
    return clone;
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateDeclarations(document, expectedStandardVersion, options = {}) {
  exactKeys(
    document,
    ["$schema", "schemaVersion", "format", "standardVersion", "access", "limits", "declarations"],
    ["schemaVersion", "format", "standardVersion", "access", "limits", "declarations"],
    "EC_ENV_DOCUMENT_INVALID",
  );
  if (document.schemaVersion !== 1 || document.format !== "edge-canon.environment-secrets/v1") fail("EC_ENV_VERSION_UNSUPPORTED");
  if (!EXACT_STANDARD.test(document.standardVersion) || document.standardVersion !== expectedStandardVersion) fail("EC_ENV_STANDARD_PIN_INVALID");
  exactKeys(document.access, ["surface", "extraProviderBindings"], ["surface", "extraProviderBindings"], "EC_ENV_DOCUMENT_INVALID");
  if (document.access.surface !== "context.env" || document.access.extraProviderBindings !== "excluded") fail("EC_ENV_DOCUMENT_INVALID");
  exactKeys(document.limits, ["bindingCount", "valueBytes", "measurement"], ["bindingCount", "valueBytes", "measurement"], "EC_ENV_DOCUMENT_INVALID");
  if (document.limits.bindingCount !== 64 || document.limits.valueBytes !== 5120 || document.limits.measurement !== "utf-8") fail("EC_ENV_DOCUMENT_INVALID");
  if (!Array.isArray(document.declarations)) fail("EC_ENV_DOCUMENT_INVALID");
  if (document.declarations.length > 64) fail("EC_ENV_BINDING_LIMIT_EXCEEDED");
  const declarations = new Map();
  const resourceNames = new Set(options.resourceNames ?? []);
  for (const declaration of document.declarations) {
    exactKeys(declaration, ["name", "kind", "valueType", "required"], ["name", "kind", "valueType", "required"], "EC_ENV_DOCUMENT_INVALID");
    if (typeof declaration.name !== "string" || !NAME.test(declaration.name)) fail("EC_ENV_NAME_INVALID");
    if (declarations.has(declaration.name)) fail("EC_ENV_DUPLICATE_NAME");
    if (resourceNames.has(declaration.name)) fail("EC_ENV_NAMESPACE_COLLISION");
    if (!new Set(["config", "secret"]).has(declaration.kind) || !new Set(["string", "json"]).has(declaration.valueType) || typeof declaration.required !== "boolean") fail("EC_ENV_DECLARATION_INVALID");
    if (declaration.kind === "secret" && declaration.valueType !== "string") fail("EC_ENV_DECLARATION_INVALID");
    declarations.set(declaration.name, { ...declaration });
  }
  return { declarations, identity: documentIdentity(document) };
}

export function validateSnapshot(document, snapshot, secretRevisions, expectedStandardVersion, options = {}) {
  const declarationResult = validateDeclarations(document, expectedStandardVersion, options);
  exactKeys(
    snapshot,
    ["$schema", "schemaVersion", "format", "standardVersion", "deploymentVersionId", "environmentId", "declarationsSha256", "activation", "bindings"],
    ["schemaVersion", "format", "standardVersion", "deploymentVersionId", "environmentId", "declarationsSha256", "activation", "bindings"],
    "EC_ENV_SNAPSHOT_INVALID",
  );
  if (snapshot.schemaVersion !== 1 || snapshot.format !== "edge-canon.environment-binding-snapshot/v1") fail("EC_ENV_VERSION_UNSUPPORTED");
  if (!EXACT_STANDARD.test(snapshot.standardVersion) || snapshot.standardVersion !== expectedStandardVersion) fail("EC_ENV_STANDARD_PIN_INVALID");
  if (!IDENTITY.test(snapshot.deploymentVersionId) || !IDENTITY.test(snapshot.environmentId)) fail("EC_ENV_SNAPSHOT_INVALID");
  if (!SHA256.test(snapshot.declarationsSha256) || snapshot.declarationsSha256 !== declarationResult.identity) fail("EC_ENV_DECLARATION_IDENTITY_MISMATCH");
  exactKeys(snapshot.activation, ["mode", "missingRequired", "unavailableSecretRevision"], ["mode", "missingRequired", "unavailableSecretRevision"], "EC_ENV_SNAPSHOT_INVALID");
  if (snapshot.activation.mode !== "version-bound-atomic" || snapshot.activation.missingRequired !== "reject" || snapshot.activation.unavailableSecretRevision !== "reject") fail("EC_ENV_SNAPSHOT_INVALID");
  if (!Array.isArray(snapshot.bindings)) fail("EC_ENV_SNAPSHOT_INVALID");
  if (snapshot.bindings.length > 64) fail("EC_ENV_BINDING_LIMIT_EXCEEDED");

  const bindings = new Map();
  for (const binding of snapshot.bindings) {
    if (!object(binding) || typeof binding.name !== "string" || !NAME.test(binding.name)) fail("EC_ENV_BINDING_INVALID");
    if (bindings.has(binding.name)) fail("EC_ENV_DUPLICATE_NAME");
    const declaration = declarationResult.declarations.get(binding.name);
    if (!declaration) fail("EC_ENV_BINDING_UNDECLARED");
    if (binding.kind !== declaration.kind || binding.valueType !== declaration.valueType) fail("EC_ENV_BINDING_TYPE_MISMATCH");
    if (typeof binding.revision !== "string" || !IDENTITY.test(binding.revision)) fail("EC_ENV_BINDING_INVALID");
    if (binding.kind === "config") {
      exactKeys(binding, ["name", "kind", "valueType", "revision", "value"], ["name", "kind", "valueType", "revision", "value"], "EC_ENV_BINDING_INVALID");
      if (valueBytes(binding.value, binding.valueType) > 5120) fail("EC_ENV_VALUE_LIMIT_EXCEEDED");
      if (binding.revision !== configRevision(binding.value, binding.valueType)) fail("EC_ENV_CONFIG_REVISION_MISMATCH");
      bindings.set(binding.name, { ...binding, value: stableValue(binding.value) });
    } else {
      exactKeys(binding, ["name", "kind", "valueType", "revision"], ["name", "kind", "valueType", "revision"], "EC_ENV_BINDING_INVALID");
      if (!secretRevisions.has(binding.revision)) fail("EC_ENV_SECRET_REVISION_UNAVAILABLE");
      const value = secretRevisions.get(binding.revision);
      if (typeof value !== "string") fail("EC_ENV_VALUE_INVALID");
      if (Buffer.byteLength(value, "utf8") > 5120) fail("EC_ENV_VALUE_LIMIT_EXCEEDED");
      bindings.set(binding.name, { ...binding, value });
    }
  }
  for (const declaration of declarationResult.declarations.values()) {
    if (declaration.required && !bindings.has(declaration.name)) fail("EC_ENV_REQUIRED_MISSING");
  }
  return {
    declarations: declarationResult.declarations,
    declarationIdentity: declarationResult.identity,
    snapshotIdentity: documentIdentity(snapshot),
    snapshot: structuredClone(snapshot),
    bindings,
  };
}

export function materializeInvocation(prepared, providerBindings = {}) {
  const env = Object.create(null);
  const processEnvironment = Object.create(null);
  for (const [name, binding] of prepared.bindings) {
    env[name] = binding.valueType === "json" ? deepFreeze(cloneJson(binding.value)) : binding.value;
    if (binding.kind === "config" && binding.valueType === "string") processEnvironment[name] = binding.value;
  }
  for (const name of Object.keys(providerBindings)) {
    if (prepared.bindings.has(name)) continue;
  }
  return {
    env: Object.freeze(env),
    processEnvironment,
    snapshotIdentity: prepared.snapshotIdentity,
    deploymentVersionId: prepared.snapshot.deploymentVersionId,
  };
}

export function managementMetadata(prepared) {
  return [...prepared.bindings.values()].map(({ name, kind, valueType, revision }) => ({ name, kind, valueType, revision }));
}

export class EnvironmentController {
  constructor() {
    this.current = null;
    this.audit = [];
    this.staging = new Map();
  }

  prepare(document, snapshot, secretRevisions, standardVersion, options = {}) {
    const prepared = validateSnapshot(document, snapshot, secretRevisions, standardVersion, options);
    this.staging.set(prepared.snapshotIdentity, prepared);
    return prepared;
  }

  activate(prepared, expectedCurrent = this.current?.snapshotIdentity ?? null) {
    const actual = this.current?.snapshotIdentity ?? null;
    if (actual !== expectedCurrent) fail("EC_ENV_ACTIVATION_CONFLICT");
    if (this.staging.get(prepared.snapshotIdentity) !== prepared) fail("EC_ENV_SNAPSHOT_NOT_PREPARED");
    this.current = prepared;
    this.staging.delete(prepared.snapshotIdentity);
    this.audit.push({ sequence: this.audit.length + 1, snapshotIdentity: prepared.snapshotIdentity });
    return prepared.snapshotIdentity;
  }

  invoke(providerBindings = {}) {
    if (!this.current) fail("EC_ENV_NO_ACTIVE_SNAPSHOT");
    return materializeInvocation(this.current, providerBindings);
  }

  discard(prepared) {
    return this.staging.delete(prepared.snapshotIdentity);
  }
}

export function captureCode(operation) {
  try {
    operation();
    return null;
  } catch (error) {
    if (!(error instanceof EnvironmentError)) throw error;
    return error.code;
  }
}
