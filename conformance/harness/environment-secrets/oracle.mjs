import fs from "node:fs";
import { fileURLToPath } from "node:url";

const EXPECTED_CASES = Array.from({ length: 12 }, (_, index) => `EC-ENV-T${String(index + 1).padStart(3, "0")}`);
const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_STANDARD = /^edge-canon\.next@[0-9a-f]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  requireValue(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} keys differ`);
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const VERIFIERS = {
  "EC-ENV-T001"(data) {
    exactKeys(data, ["declarationIdentity", "snapshotIdentity", "deploymentVersionId", "contextKeys", "providerExtraVisible"], "T001 data");
    requireValue(SHA256.test(data.declarationIdentity) && SHA256.test(data.snapshotIdentity), "T001 identities are invalid");
    requireValue(data.deploymentVersionId === "deployment-old", "T001 deployment identity differs");
    requireValue(equal(data.contextKeys, ["API_TOKEN", "APP_MODE", "SETTINGS"]), "T001 context keys differ");
    requireValue(data.providerExtraVisible === false, "T001 exposed a provider binding");
  },
  "EC-ENV-T002"(data) {
    exactKeys(data, ["runtimeTypes", "valueDigests", "optionalOwnProperty", "secretJsonCode"], "T002 data");
    requireValue(equal(data.runtimeTypes, { APP_MODE: "string", SETTINGS: "object", API_TOKEN: "string" }), "T002 runtime types differ");
    requireValue(Object.values(data.valueDigests).every((value) => SHA256.test(value)), "T002 value digests are invalid");
    requireValue(data.optionalOwnProperty === false && data.secretJsonCode === "EC_ENV_DECLARATION_INVALID", "T002 optional or secret/json semantics differ");
  },
  "EC-ENV-T003"(data) {
    exactKeys(data, ["prototypeIsNull", "freeze", "nestedMutationRejected", "secondMarker", "processKeys", "processMutationChangedEnv", "canariesVisible"], "T003 data");
    requireValue(data.prototypeIsNull && Object.values(data.freeze).every(Boolean), "T003 environment was not recursively frozen");
    requireValue(data.nestedMutationRejected && data.secondMarker === "old", "T003 mutation crossed invocation boundaries");
    requireValue(equal(data.processKeys, ["APP_MODE"]) && !data.processMutationChangedEnv && !data.canariesVisible, "T003 Node projection or provider isolation differs");
  },
  "EC-ENV-T004"(data) {
    exactKeys(data, ["mutations", "providerDerivationCount", "diagnosticsSanitized"], "T004 data");
    requireValue(data.mutations.length === 5 && data.mutations.every((item) => item.code === item.expected), "T004 mutation code differs");
    requireValue(data.providerDerivationCount === 0 && data.diagnosticsSanitized, "T004 derived output or leaked diagnostics");
  },
  "EC-ENV-T005"(data) {
    exactKeys(data, ["variants", "activeUnchanged", "handlerCount", "partialContextCount"], "T005 data");
    requireValue(data.variants.length === 5 && data.variants.every((item) => item.code === item.expected), "T005 activation failure code differs");
    requireValue(data.activeUnchanged && data.handlerCount === 0 && data.partialContextCount === 0, "T005 activation was not all-or-nothing");
  },
  "EC-ENV-T006"(data) {
    exactKeys(data, ["requestCount", "observedPairs", "mixedPairCount", "deterministicIdentity", "winningIdentity", "losingCode", "auditSequences"], "T006 data");
    requireValue(data.requestCount === 64 && equal(data.observedPairs, [["old", "old"], ["new", "new"]]) && data.mixedPairCount === 0, "T006 observed a mixed snapshot");
    requireValue(data.deterministicIdentity && SHA256.test(data.winningIdentity) && data.losingCode === "EC_ENV_ACTIVATION_CONFLICT", "T006 activation CAS differs");
    requireValue(equal(data.auditSequences, [1, 2]), "T006 audit order differs");
  },
  "EC-ENV-T007"(data) {
    exactKeys(data, ["artifactIdentityBefore", "artifactIdentityAfter", "oldValueDigest", "newValueDigest", "inFlightValueDigest", "buildVariableVisible"], "T007 data");
    requireValue(data.artifactIdentityBefore === data.artifactIdentityAfter && SHA256.test(data.artifactIdentityBefore), "T007 runtime value changed the artifact");
    requireValue(data.oldValueDigest === data.inFlightValueDigest && data.oldValueDigest !== data.newValueDigest && !data.buildVariableVisible, "T007 deployment or build/runtime isolation differs");
  },
  "EC-ENV-T008"(data) {
    exactKeys(data, ["revisions", "revisionsDistinct", "retainedWhileReferenced", "rollbackValueDigest", "unavailableRollbackCode", "currentAfterFailure"], "T008 data");
    requireValue(equal(data.revisions, ["secret-token-old", "secret-token-new"]) && data.revisionsDistinct && data.retainedWhileReferenced, "T008 revision lifecycle differs");
    requireValue(SHA256.test(data.rollbackValueDigest) && data.unavailableRollbackCode === "EC_ENV_SECRET_REVISION_UNAVAILABLE" && SHA256.test(data.currentAfterFailure), "T008 rollback failure differs");
  },
  "EC-ENV-T009"(data) {
    exactKeys(data, ["acceptedCounts", "count65Code", "maximumBytes", "maximumAccepted", "overBytes", "overCode", "uploadCountAfterFailures"], "T009 data");
    requireValue(equal(data.acceptedCounts, [63, 64]) && data.count65Code === "EC_ENV_BINDING_LIMIT_EXCEEDED", "T009 binding limit differs");
    requireValue(data.maximumBytes === 5120 && data.maximumAccepted && data.overBytes === 5121 && data.overCode === "EC_ENV_VALUE_LIMIT_EXCEEDED", "T009 value byte limit differs");
    requireValue(data.uploadCountAfterFailures === 0, "T009 uploaded an invalid snapshot");
  },
  "EC-ENV-T010"(data) {
    exactKeys(data, ["metadataKeys", "metadataHasValue", "sentinelOccurrences", "tenantDigestsDiffer", "namespaceCollisionCode"], "T010 data");
    requireValue(equal(data.metadataKeys, ["kind", "name", "revision", "valueType"]) && !data.metadataHasValue, "T010 management API returned a value");
    requireValue(data.sentinelOccurrences === 0 && data.tenantDigestsDiffer && data.namespaceCollisionCode === "EC_ENV_NAMESPACE_COLLISION", "T010 secret containment or isolation differs");
  },
  "EC-ENV-T011"(data) {
    exactKeys(data, ["activeUnchanged", "operationState", "cleanupRemoved", "stagedCount", "cleanupIdentity"], "T011 data");
    requireValue(data.activeUnchanged && data.operationState === "failed-cleaned" && data.cleanupRemoved && data.stagedCount === 0 && SHA256.test(data.cleanupIdentity), "T011 cleanup/recovery differs");
  },
  "EC-ENV-T012"(data) {
    exactKeys(data, ["versions", "sourceIdentity", "migratedIdentity", "sourceMutated", "behaviorDiff"], "T012 data");
    requireValue(data.versions.length === 3 && data.versions.every((item) => item.code === item.expected && item.secretReads === 0), "T012 version rejection was late or unstable");
    requireValue(SHA256.test(data.sourceIdentity) && SHA256.test(data.migratedIdentity) && data.sourceIdentity !== data.migratedIdentity && !data.sourceMutated, "T012 migration mutated or reused its input");
    requireValue(equal(data.behaviorDiff, { addedOptionalDeclaration: "MIGRATED_OPTION" }), "T012 migration diff differs");
  },
};

export function verifyDocument(document) {
  exactKeys(document, ["schemaVersion", "standardId", "suiteId", "backend", "artifactSha256", "cases"], "observation document");
  requireValue(document.schemaVersion === 1 && document.standardId === "edge-canon.next" && document.suiteId === "EC-ENV", "observation identity differs");
  requireValue(SHA256.test(document.artifactSha256), "environment artifact digest is invalid");
  exactKeys(document.backend, ["id", "implementationVersion", "standardVersion"], "backend");
  requireValue(document.backend.id === "edge-canon-reference-environment" && document.backend.implementationVersion === "edge-canon-reference-environment/1", "reference backend identity differs");
  requireValue(EXACT_STANDARD.test(document.backend.standardVersion), "backend did not run an exact standard commit");
  requireValue(Array.isArray(document.cases), "cases must be an array");
  const byId = new Map();
  for (const item of document.cases) {
    exactKeys(item, ["id", "observedAt", "data", "evidenceRefs"], "case record");
    requireValue(!byId.has(item.id) && Number.isFinite(Date.parse(item.observedAt)), "case identity or timestamp is invalid");
    requireValue(Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0 && new Set(item.evidenceRefs).size === item.evidenceRefs.length, "case evidence references are invalid");
    byId.set(item.id, item);
  }
  requireValue(byId.size === EXPECTED_CASES.length && EXPECTED_CASES.every((id) => byId.has(id)), "draft harness requires exactly twelve environment cases");
  for (const id of EXPECTED_CASES) VERIFIERS[id](byId.get(id).data);
  return { suiteId: "EC-ENV", status: "pass", caseIds: [...EXPECTED_CASES] };
}

function main(file) {
  requireValue(file, "usage: node oracle.mjs OBSERVATIONS.json");
  process.stdout.write(`${JSON.stringify(verifyDocument(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2)}\n`);
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  try { main(process.argv[2]); } catch (error) { process.stderr.write(`EC-ENV oracle failed: ${error.message}\n`); process.exitCode = 1; }
}
