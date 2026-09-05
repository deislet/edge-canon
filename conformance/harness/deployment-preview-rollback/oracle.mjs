import fs from "node:fs";
import { fileURLToPath } from "node:url";

const CASE_IDS = Array.from({ length: 12 }, (_, index) => `EC-DEPLOY-T${String(index + 1).padStart(3, "0")}`);
const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_STANDARD = /^edge-canon\.next@[0-9a-f]{40}$/;
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function exactKeys(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  requireValue(same(Object.keys(value).sort(), [...keys].sort()), `${label} keys differ`);
}

const VERIFY = {
  "EC-DEPLOY-T001"(data) {
    exactKeys(data, ["uploadIdentityStable", "productionUnchangedByUpload", "planDigestsDistinct", "storedPlanImmutable", "statusTransitions", "auditSequences"], "T001 data");
    requireValue(data.uploadIdentityStable && data.productionUnchangedByUpload && data.planDigestsDistinct && data.storedPlanImmutable, "T001 immutable identity separation differs");
    requireValue(same(data.statusTransitions, ["preparing", "prepared", "verifying", "ready", "activating", "active"]), "T001 state machine differs");
    requireValue(same(data.auditSequences, [1, 2, 3, 4, 5, 6]), "T001 CAS audit ordering differs");
  },
  "EC-DEPLOY-T002"(data) {
    exactKeys(data, ["prepared", "targetStates", "productionGeneration", "candidateProductionRequests", "cleanupState", "cleanupIdentity"], "T002 data");
    requireValue(!data.prepared && Object.values(data.targetStates).includes("failed"), "T002 did not observe a target failure");
    requireValue(data.productionGeneration === "generation-old" && data.candidateProductionRequests === 0, "T002 changed production after partial prepare");
    requireValue(data.cleanupState === "failed-cleaned" && SHA256.test(data.cleanupIdentity), "T002 cleanup is not retryable/identified");
  },
  "EC-DEPLOY-T003"(data) {
    exactKeys(data, ["validSelection", "invalidCodes", "externalVersionHeaderAccepted", "privatePreviewAuthorized", "runtimeCredentialCanManage", "logKeys"], "T003 data");
    requireValue(data.validSelection === "version-new", "T003 valid override did not select the current candidate");
    requireValue(same(data.invalidCodes, ["EC_DEPLOY_OVERRIDE_INVALID", "EC_DEPLOY_OVERRIDE_EXPIRED", "EC_DEPLOY_OVERRIDE_SCOPE_MISMATCH", "EC_DEPLOY_OVERRIDE_VERSION_INVALID"]), "T003 invalid override codes differ");
    requireValue(!data.externalVersionHeaderAccepted && data.privatePreviewAuthorized && !data.runtimeCredentialCanManage, "T003 trust boundary differs");
    requireValue(!data.logKeys.some((key) => ["token", "subject", "signature"].includes(key)), "T003 leaked override material");
  },
  "EC-DEPLOY-T004"(data) {
    exactKeys(data, ["generationBeforeRoutable", "firstObservation", "stateWhileAckMissing", "routeGenerationWhileActivating", "finalObservation", "finalState", "transitionOrder", "selectorMutations"], "T004 data");
    requireValue(data.generationBeforeRoutable === "generation-old" && !data.firstObservation && data.stateWhileAckMissing === "activating", "T004 declared active before observations");
    requireValue(data.routeGenerationWhileActivating === "generation-new" && data.finalObservation && data.finalState === "active", "T004 routing generation observation differs");
    requireValue(data.transitionOrder.indexOf("ready") < data.transitionOrder.indexOf("activating") && data.transitionOrder.at(-1) === "active" && data.selectorMutations === 1, "T004 activation ordering differs");
  },
  "EC-DEPLOY-T005"(data) {
    exactKeys(data, ["acceptedWeights", "invalidCodes", "providerMutationCount", "normalizedInvalidPlans"], "T005 data");
    requireValue(same(data.acceptedWeights, [0, 1, 9999, 10000]), "T005 basis-point boundaries differ");
    requireValue(same(data.invalidCodes, ["EC_DEPLOY_WEIGHT_INVALID", "EC_DEPLOY_WEIGHT_INVALID", "EC_DEPLOY_ROLE_INVALID", "EC_DEPLOY_VERSION_COUNT_INVALID", "EC_DEPLOY_STANDARD_PIN_INVALID"]), "T005 invalid plan codes differ");
    requireValue(data.providerMutationCount === 0 && data.normalizedInvalidPlans === 0, "T005 mutated provider or normalized invalid input");
  },
  "EC-DEPLOY-T006"(data) {
    exactKeys(data, ["beforeAssignments", "afterAssignments", "assignmentsStable", "requestChainVersions", "inFlightVersionStable", "forgedSelectorAccepted"], "T006 data");
    requireValue(data.assignmentsStable && same(data.beforeAssignments, data.afterAssignments), "T006 affinity changed after weight update");
    requireValue(data.requestChainVersions.every((chain) => chain.length === 3 && new Set(chain).size === 1), "T006 split a same-origin request chain");
    requireValue(data.inFlightVersionStable && !data.forgedSelectorAccepted, "T006 migrated in-flight work or trusted client selection");
  },
  "EC-DEPLOY-T007"(data) {
    exactKeys(data, ["states", "missingDataWeightChanged", "resumedGateReevaluated", "evidenceDigests", "automaticEvidenceRetained"], "T007 data");
    requireValue(same(data.states, ["progressing", "aborting", "paused"]) && !data.missingDataWeightChanged, "T007 gate fail/insufficient semantics differ");
    requireValue(data.resumedGateReevaluated && data.automaticEvidenceRetained && data.evidenceDigests.length === 3 && data.evidenceDigests.every((item) => SHA256.test(item)), "T007 did not retain gate evidence");
  },
  "EC-DEPLOY-T008"(data) {
    exactKeys(data, ["streamVersions", "websocketVersions", "queueDeliveryCount", "cronDeliveryCount", "serviceContext", "incompatibleCalleeCode", "activationBlocked"], "T008 data");
    requireValue(new Set(data.streamVersions).size === 1 && new Set(data.websocketVersions).size === 1, "T008 moved in-flight stream/socket");
    requireValue(data.queueDeliveryCount === 1 && data.cronDeliveryCount === 1, "T008 duplicated an async trigger");
    requireValue(same(Object.keys(data.serviceContext).sort(), ["affinity", "callerDeploymentId", "callerVersionId"]), "T008 service context differs");
    requireValue(data.incompatibleCalleeCode === "EC_DEPLOY_SERVICE_CONTRACT_INCOMPATIBLE" && data.activationBlocked, "T008 did not block incompatible service activation");
  },
  "EC-DEPLOY-T009"(data) {
    exactKeys(data, ["rollbackIsNewRevision", "rollbackVersionId", "rollbackSnapshotId", "applicationDataDigestBefore", "applicationDataDigestAfter", "unavailableSnapshotCode", "selectorAfterUnavailable"], "T009 data");
    requireValue(data.rollbackIsNewRevision && data.rollbackVersionId === "version-old" && data.rollbackSnapshotId === "snapshot-old", "T009 rollback identity/snapshot differs");
    requireValue(SHA256.test(data.applicationDataDigestBefore) && data.applicationDataDigestBefore === data.applicationDataDigestAfter, "T009 rolled back application data");
    requireValue(data.unavailableSnapshotCode === "EC_DEPLOY_ROLLBACK_SNAPSHOT_UNAVAILABLE" && data.selectorAfterUnavailable === "deployment-new", "T009 moved selector after rollback preflight failure");
  },
  "EC-DEPLOY-T010"(data) {
    exactKeys(data, ["firstOperationId", "retryOperationId", "providerMutationCount", "competingCode", "unknownResultState", "recoveryAction", "reconciledGeneration"], "T010 data");
    requireValue(data.firstOperationId === data.retryOperationId && data.providerMutationCount === 1, "T010 replayed provider mutation");
    requireValue(data.competingCode === "EC_DEPLOY_ACTIVATION_CONFLICT", "T010 CAS conflict differs");
    requireValue(data.unknownResultState === "reconciling" && data.recoveryAction === "inspect-provider-operation" && data.reconciledGeneration === "generation-new", "T010 unknown result was guessed instead of reconciled");
  },
  "EC-DEPLOY-T011"(data) {
    exactKeys(data, ["retainedVersions", "retainedCount", "referencedOldVersionRemoved", "configuredTargets", "attemptedServingTargets", "unreachableTargetOutcome", "cleanupRetryable"], "T011 data");
    requireValue(data.retainedCount === 3 && same(data.retainedVersions, ["version-2", "version-3", "version-4"]), "T011 minimum retention differs");
    requireValue(!data.referencedOldVersionRemoved && same(data.configuredTargets, data.attemptedServingTargets), "T011 removed a reference or shrank atomic serving set");
    requireValue(data.unreachableTargetOutcome === "activation-blocked" && data.cleanupRetryable, "T011 unreachable target/cleanup semantics differ");
  },
  "EC-DEPLOY-T012"(data) {
    exactKeys(data, ["earlyCodes", "resourceResolutionCount", "sourceDigest", "migratedDigest", "sourceMutated", "behaviorDiff", "writerSwitchBeforeAgreement", "generationFencingRetained"], "T012 data");
    requireValue(same(data.earlyCodes, ["EC_DEPLOY_VERSION_UNSUPPORTED", "EC_DEPLOY_DOCUMENT_INVALID", "EC_DEPLOY_STANDARD_PIN_INVALID"]) && data.resourceResolutionCount === 0, "T012 version validation was late or unstable");
    requireValue(SHA256.test(data.sourceDigest) && SHA256.test(data.migratedDigest) && data.sourceDigest !== data.migratedDigest && !data.sourceMutated, "T012 migration mutated/reused source identity");
    requireValue(same(data.behaviorDiff, { mapping: "v1-to-next", deploymentIdChanged: true }) && !data.writerSwitchBeforeAgreement && data.generationFencingRetained, "T012 writer migration fencing differs");
  },
};

export function verifyDocument(document) {
  exactKeys(document, ["schemaVersion", "standardId", "suiteId", "backend", "artifactSha256", "cases"], "observation document");
  requireValue(document.schemaVersion === 1 && document.standardId === "edge-canon.next" && document.suiteId === "EC-DEPLOY", "observation identity differs");
  requireValue(SHA256.test(document.artifactSha256), "deployment artifact digest is invalid");
  exactKeys(document.backend, ["id", "implementationVersion", "standardVersion"], "backend");
  requireValue(document.backend.id === "edge-canon-reference-deployment" && document.backend.implementationVersion === "edge-canon-reference-deployment/1" && EXACT_STANDARD.test(document.backend.standardVersion), "reference backend identity differs");
  requireValue(Array.isArray(document.cases), "cases must be an array");
  const byId = new Map();
  for (const item of document.cases) {
    exactKeys(item, ["id", "observedAt", "data", "evidenceRefs"], "case record");
    requireValue(!byId.has(item.id) && Number.isFinite(Date.parse(item.observedAt)), "case identity or timestamp is invalid");
    requireValue(Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0 && new Set(item.evidenceRefs).size === item.evidenceRefs.length, "case evidence references are invalid");
    byId.set(item.id, item);
  }
  requireValue(byId.size === CASE_IDS.length && CASE_IDS.every((id) => byId.has(id)), "draft harness requires exactly twelve deployment cases");
  for (const id of CASE_IDS) VERIFY[id](byId.get(id).data);
  return { suiteId: "EC-DEPLOY", status: "pass", caseIds: [...CASE_IDS] };
}

function main(file) { requireValue(file, "usage: node oracle.mjs OBSERVATIONS.json"); process.stdout.write(`${JSON.stringify(verifyDocument(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2)}\n`); }
if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  try { main(process.argv[2]); } catch (error) { process.stderr.write(`EC-DEPLOY oracle failed: ${error.message}\n`); process.exitCode = 1; }
}
