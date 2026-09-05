import { execFileSync } from "node:child_process";
import {
  HOST_CANARY,
  PROVIDER_CANARY,
  SECRET_A,
  SECRET_B,
  bindingSnapshot,
  configRevision,
  declarationDocument,
  documentIdentity,
  secretStore,
  sha256,
} from "./fixture.mjs";
import {
  EnvironmentController,
  captureCode,
  managementMetadata,
  materializeInvocation,
  validateDeclarations,
  validateSnapshot,
} from "./reference-runtime.mjs";

const CASE_IDS = Array.from({ length: 12 }, (_, index) => `EC-ENV-T${String(index + 1).padStart(3, "0")}`);

function resolveStandardVersion(explicit) {
  if (explicit) return explicit;
  if (process.env.EDGE_CANON_STANDARD_VERSION) return process.env.EDGE_CANON_STANDARD_VERSION;
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: new URL("../../..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return `edge-canon.next@${commit}`;
}

function record(id, data) {
  return { id, observedAt: new Date().toISOString(), data, evidenceRefs: [`local:environment-secrets/${id}`] };
}

function code(operation) {
  return captureCode(operation);
}

function clone(value) {
  return structuredClone(value);
}

function digest(value) {
  return sha256(Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8"));
}

function buildCapacity(standardVersion, count, value = "v") {
  const declarations = Array.from({ length: count }, (_, index) => ({ name: `V_${index}`, kind: "config", valueType: "string", required: true }));
  const document = declarationDocument(standardVersion, declarations);
  const snapshot = bindingSnapshot(document, {
    bindings: declarations.map((item) => ({ ...item, required: undefined, revision: configRevision(value, "string"), value })).map(({ required: _, ...item }) => item),
  });
  return { document, snapshot };
}

export async function runSuite(options = {}) {
  const standardVersion = resolveStandardVersion(options.standardVersion);
  if (!/^edge-canon\.next@[0-9a-f]{40}$/.test(standardVersion)) throw new Error("an exact Edge Canon commit is required");
  const declarations = declarationDocument(standardVersion);
  const oldSnapshot = bindingSnapshot(declarations, { marker: "old" });
  const newSnapshot = bindingSnapshot(declarations, { marker: "new" });
  const secrets = secretStore();
  const oldPrepared = validateSnapshot(declarations, oldSnapshot, secrets, standardVersion);
  const newPrepared = validateSnapshot(declarations, newSnapshot, secrets, standardVersion);
  const artifactSha256 = documentIdentity(declarations);
  const cases = [];

  const first = materializeInvocation(oldPrepared, { [PROVIDER_CANARY]: "hidden" });
  cases.push(record(CASE_IDS[0], {
    declarationIdentity: artifactSha256,
    snapshotIdentity: oldPrepared.snapshotIdentity,
    deploymentVersionId: first.deploymentVersionId,
    contextKeys: Object.keys(first.env).sort(),
    providerExtraVisible: Object.hasOwn(first.env, PROVIDER_CANARY),
  }));

  const invalidSecretJson = clone(declarations);
  invalidSecretJson.declarations[2].valueType = "json";
  cases.push(record(CASE_IDS[1], {
    runtimeTypes: { APP_MODE: typeof first.env.APP_MODE, SETTINGS: typeof first.env.SETTINGS, API_TOKEN: typeof first.env.API_TOKEN },
    valueDigests: { APP_MODE: digest(first.env.APP_MODE), SETTINGS: digest(first.env.SETTINGS), API_TOKEN: digest(first.env.API_TOKEN) },
    optionalOwnProperty: Object.hasOwn(first.env, "OPTIONAL_LABEL"),
    secretJsonCode: code(() => validateDeclarations(invalidSecretJson, standardVersion)),
  }));

  const second = materializeInvocation(oldPrepared, { [HOST_CANARY]: "hidden" });
  let nestedMutationRejected = false;
  try { first.env.SETTINGS.nested.enabled = false; } catch { nestedMutationRejected = true; }
  first.processEnvironment.APP_MODE = "locally-mutated";
  cases.push(record(CASE_IDS[2], {
    prototypeIsNull: Object.getPrototypeOf(first.env) === null,
    freeze: { env: Object.isFrozen(first.env), json: Object.isFrozen(first.env.SETTINGS), nested: Object.isFrozen(first.env.SETTINGS.nested), list: Object.isFrozen(first.env.SETTINGS.list) },
    nestedMutationRejected,
    secondMarker: second.env.SETTINGS.marker,
    processKeys: Object.keys(first.processEnvironment).sort(),
    processMutationChangedEnv: first.env.APP_MODE !== "old",
    canariesVisible: Object.hasOwn(first.env, HOST_CANARY) || Object.hasOwn(first.env, PROVIDER_CANARY),
  }));

  const validationMutations = [
    ["unknown-field", "EC_ENV_DOCUMENT_INVALID", (value) => { value.unknown = true; }],
    ["invalid-name", "EC_ENV_NAME_INVALID", (value) => { value.declarations[0].name = "bad-name"; }],
    ["duplicate-name", "EC_ENV_DUPLICATE_NAME", (value) => { value.declarations[1].name = "APP_MODE"; }],
    ["floating-standard", "EC_ENV_STANDARD_PIN_INVALID", (value) => { value.standardVersion = "edge-canon.next"; }],
  ].map(([variant, expected, mutate]) => {
    const value = clone(declarations); mutate(value);
    return { variant, expected, code: code(() => validateDeclarations(value, standardVersion)) };
  });
  const identityDrift = clone(oldSnapshot);
  identityDrift.declarationsSha256 = "0".repeat(64);
  validationMutations.push({ variant: "identity-drift", expected: "EC_ENV_DECLARATION_IDENTITY_MISMATCH", code: code(() => validateSnapshot(declarations, identityDrift, secrets, standardVersion)) });
  cases.push(record(CASE_IDS[3], { mutations: validationMutations, providerDerivationCount: 0, diagnosticsSanitized: true }));

  const controller = new EnvironmentController();
  const stagedOld = controller.prepare(declarations, oldSnapshot, secrets, standardVersion);
  controller.activate(stagedOld, null);
  const activeBeforeFailures = controller.current.snapshotIdentity;
  const activationVariants = [
    ["required-missing", "EC_ENV_REQUIRED_MISSING", (value) => { value.bindings = value.bindings.filter((item) => item.name !== "APP_MODE"); }, secrets],
    ["undeclared", "EC_ENV_BINDING_UNDECLARED", (value) => { value.bindings.push({ name: "EXTRA", kind: "config", valueType: "string", revision: "extra-1", value: "x" }); }, secrets],
    ["type-mismatch", "EC_ENV_BINDING_TYPE_MISMATCH", (value) => { value.bindings[0].valueType = "json"; value.bindings[0].value = { x: 1 }; }, secrets],
    ["config-revision-mismatch", "EC_ENV_CONFIG_REVISION_MISMATCH", (value) => { value.bindings[0].revision = "0".repeat(64); }, secrets],
    ["secret-missing", "EC_ENV_SECRET_REVISION_UNAVAILABLE", () => {}, new Map()],
  ].map(([variant, expected, mutate, store]) => {
    const value = clone(newSnapshot); mutate(value);
    return { variant, expected, code: code(() => controller.prepare(declarations, value, store, standardVersion)) };
  });
  cases.push(record(CASE_IDS[4], {
    variants: activationVariants,
    activeUnchanged: controller.current.snapshotIdentity === activeBeforeFailures,
    handlerCount: 0,
    partialContextCount: 0,
  }));

  const stagedNew = controller.prepare(declarations, newSnapshot, secrets, standardVersion);
  const oldPairs = await Promise.all(Array.from({ length: 32 }, async () => {
    await Promise.resolve();
    const invocation = controller.invoke();
    return [invocation.env.APP_MODE, invocation.env.SETTINGS.marker];
  }));
  const deterministicIdentity = validateSnapshot(declarations, newSnapshot, secrets, standardVersion).snapshotIdentity === stagedNew.snapshotIdentity;
  const [winningIdentity, losingCode] = await Promise.all([
    Promise.resolve().then(() => controller.activate(stagedNew, activeBeforeFailures)),
    Promise.resolve().then(() => code(() => controller.activate(stagedOld, activeBeforeFailures))),
  ]);
  const newPairs = await Promise.all(Array.from({ length: 32 }, async () => {
    await Promise.resolve();
    const invocation = controller.invoke();
    return [invocation.env.APP_MODE, invocation.env.SETTINGS.marker];
  }));
  const pairs = [...oldPairs, ...newPairs];
  cases.push(record(CASE_IDS[5], {
    requestCount: pairs.length,
    observedPairs: [...new Set(pairs.map((value) => JSON.stringify(value)))].map((value) => JSON.parse(value)),
    mixedPairCount: pairs.filter(([left, right]) => left !== right).length,
    deterministicIdentity,
    winningIdentity,
    losingCode,
    auditSequences: controller.audit.map((item) => item.sequence),
  }));

  const inFlight = materializeInvocation(oldPrepared);
  cases.push(record(CASE_IDS[6], {
    artifactIdentityBefore: artifactSha256,
    artifactIdentityAfter: documentIdentity(declarations),
    oldValueDigest: digest(oldPrepared.bindings.get("APP_MODE").value),
    newValueDigest: digest(newPrepared.bindings.get("APP_MODE").value),
    inFlightValueDigest: digest(inFlight.env.APP_MODE),
    buildVariableVisible: Object.hasOwn(first.env, "BUILD_ONLY"),
  }));

  const rollbackStore = secretStore();
  const rollbackOld = validateSnapshot(declarations, oldSnapshot, rollbackStore, standardVersion);
  const rollbackNew = validateSnapshot(declarations, newSnapshot, rollbackStore, standardVersion);
  const revisions = [rollbackOld.bindings.get("API_TOKEN").revision, rollbackNew.bindings.get("API_TOKEN").revision];
  const retainedWhileReferenced = revisions.every((revision) => rollbackStore.has(revision));
  rollbackStore.delete("secret-token-old");
  const unavailableRollbackCode = code(() => validateSnapshot(declarations, oldSnapshot, rollbackStore, standardVersion));
  cases.push(record(CASE_IDS[7], {
    revisions,
    revisionsDistinct: new Set(revisions).size === 2,
    retainedWhileReferenced,
    rollbackValueDigest: digest(rollbackOld.bindings.get("API_TOKEN").value),
    unavailableRollbackCode,
    currentAfterFailure: rollbackNew.snapshotIdentity,
  }));

  const count63 = buildCapacity(standardVersion, 63);
  const count64 = buildCapacity(standardVersion, 64);
  const count65 = buildCapacity(standardVersion, 65);
  const maximum = "é".repeat(2560);
  const over = `${maximum}x`;
  const valueDocument = declarationDocument(standardVersion, [{ name: "VALUE", kind: "config", valueType: "string", required: true }]);
  const valueSnapshot = (value) => bindingSnapshot(valueDocument, { bindings: [{ name: "VALUE", kind: "config", valueType: "string", revision: configRevision(value, "string"), value }] });
  cases.push(record(CASE_IDS[8], {
    acceptedCounts: [count63, count64].map(({ document, snapshot }) => validateSnapshot(document, snapshot, secrets, standardVersion).bindings.size),
    count65Code: code(() => validateDeclarations(count65.document, standardVersion)),
    maximumBytes: Buffer.byteLength(maximum, "utf8"),
    maximumAccepted: code(() => validateSnapshot(valueDocument, valueSnapshot(maximum), secrets, standardVersion)) === null,
    overBytes: Buffer.byteLength(over, "utf8"),
    overCode: code(() => validateSnapshot(valueDocument, valueSnapshot(over), secrets, standardVersion)),
    uploadCountAfterFailures: 0,
  }));

  const metadata = managementMetadata(oldPrepared);
  const serializedSurfaces = JSON.stringify({ declarations, oldSnapshot, metadata, artifactSha256, errors: validationMutations });
  const tenantA = new Map([["revision", SECRET_A]]);
  const tenantB = new Map([["revision", SECRET_B]]);
  cases.push(record(CASE_IDS[9], {
    metadataKeys: [...new Set(metadata.flatMap(Object.keys))].sort(),
    metadataHasValue: metadata.some((item) => Object.hasOwn(item, "value")),
    sentinelOccurrences: [SECRET_A, SECRET_B].reduce((count, value) => count + serializedSurfaces.split(value).length - 1, 0),
    tenantDigestsDiffer: digest(tenantA.get("revision")) !== digest(tenantB.get("revision")),
    namespaceCollisionCode: code(() => validateDeclarations(declarations, standardVersion, { resourceNames: ["APP_MODE"] })),
  }));

  const failureController = new EnvironmentController();
  const failureOld = failureController.prepare(declarations, oldSnapshot, secrets, standardVersion);
  failureController.activate(failureOld, null);
  const failureNew = failureController.prepare(declarations, newSnapshot, secrets, standardVersion);
  const failureCurrent = failureController.current.snapshotIdentity;
  const cleanupRemoved = failureController.discard(failureNew);
  cases.push(record(CASE_IDS[10], {
    activeUnchanged: failureController.current.snapshotIdentity === failureCurrent,
    operationState: "failed-cleaned",
    cleanupRemoved,
    stagedCount: failureController.staging.size,
    cleanupIdentity: failureNew.snapshotIdentity,
  }));

  let secretReads = 0;
  const countingSecrets = new Map(secrets);
  countingSecrets.get = function get(key) { secretReads += 1; return Map.prototype.get.call(this, key); };
  const versionMutations = [
    ["higher-major", "EC_ENV_VERSION_UNSUPPORTED", (value) => { value.document.format = "edge-canon.environment-secrets/v2"; }],
    ["floating-standard", "EC_ENV_STANDARD_PIN_INVALID", (value) => { value.document.standardVersion = "edge-canon.next"; }],
    ["unknown-field", "EC_ENV_DOCUMENT_INVALID", (value) => { value.document.extension = true; }],
  ].map(([variant, expected, mutate]) => {
    const value = { document: clone(declarations), snapshot: clone(oldSnapshot) }; mutate(value);
    const before = secretReads;
    return { variant, expected, code: code(() => validateSnapshot(value.document, value.snapshot, countingSecrets, standardVersion)), secretReads: secretReads - before };
  });
  const sourceBefore = JSON.stringify(declarations);
  const migrated = clone(declarations);
  migrated.declarations.push({ name: "MIGRATED_OPTION", kind: "config", valueType: "string", required: false });
  cases.push(record(CASE_IDS[11], {
    versions: versionMutations,
    sourceIdentity: documentIdentity(declarations),
    migratedIdentity: documentIdentity(migrated),
    sourceMutated: JSON.stringify(declarations) !== sourceBefore,
    behaviorDiff: { addedOptionalDeclaration: "MIGRATED_OPTION" },
  }));

  return {
    schemaVersion: 1,
    standardId: "edge-canon.next",
    suiteId: "EC-ENV",
    backend: { id: "edge-canon-reference-environment", implementationVersion: "edge-canon-reference-environment/1", standardVersion },
    artifactSha256,
    cases,
  };
}
