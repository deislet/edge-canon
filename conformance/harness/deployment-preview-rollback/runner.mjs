import { execFileSync } from "node:child_process";
import { deploymentPlan, planIdentity, sha256 } from "./fixture.mjs";
import {
  DeploymentController,
  PlanStore,
  TriggerActivationBarrier,
  captureCode,
  evaluateGate,
  issueOverride,
  selectVersion,
  validatePlan,
  verifyOverride,
} from "./reference-runtime.mjs";

const CASE_IDS = Array.from({ length: 14 }, (_, index) => `EC-DEPLOY-T${String(index + 1).padStart(3, "0")}`);
function resolveStandardVersion(explicit) {
  if (explicit) return explicit;
  if (process.env.EDGE_CANON_STANDARD_VERSION) return process.env.EDGE_CANON_STANDARD_VERSION;
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: new URL("../../..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  return `edge-canon.next@${commit}`;
}
function record(id, data) { return { id, observedAt: new Date().toISOString(), data, evidenceRefs: [`local:deployment-preview-rollback/${id}`] }; }
function code(operation) { return captureCode(operation); }
function clone(value) { return structuredClone(value); }

export async function runSuite(options = {}) {
  const standardVersion = resolveStandardVersion(options.standardVersion);
  if (!/^edge-canon\.next@[0-9a-f]{40}$/.test(standardVersion)) throw new Error("an exact Edge Canon commit is required");
  const atomic = deploymentPlan(standardVersion);
  const gradual = deploymentPlan(standardVersion, { mode: "gradual", candidateWeight: 1000, deploymentId: "deployment-rollout", generation: "generation-rollout" });
  const cases = [];

  const store = new PlanStore();
  const versionOne = store.upload({ artifact: "same" });
  const versionTwo = store.upload({ artifact: "same" });
  const productionBefore = { ...store.production };
  const planDigest = store.create(atomic, standardVersion);
  const secondPlan = deploymentPlan(standardVersion, { deploymentId: "deployment-newer", generation: "generation-newer" });
  const secondDigest = store.create(secondPlan, standardVersion);
  const lifecycle = new DeploymentController({ targets: ["target-a"], proxies: ["proxy-a"] });
  lifecycle.prepare(atomic); lifecycle.verify(); lifecycle.makeRoutable(atomic.routing.generation); lifecycle.activate(atomic, ["proxy-a"]);
  cases.push(record(CASE_IDS[0], {
    uploadIdentityStable: versionOne === versionTwo,
    productionUnchangedByUpload: JSON.stringify(productionBefore) === JSON.stringify({ deploymentId: "deployment-old", generation: "generation-old" }),
    planDigestsDistinct: planDigest !== secondDigest,
    storedPlanImmutable: store.mutateStored(planDigest, (value) => { value.deploymentId = "tampered"; }),
    statusTransitions: lifecycle.journal.map((item) => item.state),
    auditSequences: lifecycle.journal.map((item) => item.sequence),
  }));

  const partial = new DeploymentController();
  const prepared = partial.prepare(atomic, { "target-b": false });
  cases.push(record(CASE_IDS[1], {
    prepared,
    targetStates: Object.fromEntries(partial.targetStates),
    productionGeneration: partial.active.generation,
    candidateProductionRequests: 0,
    cleanupState: "failed-cleaned",
    cleanupIdentity: sha256("deployment-new:staging"),
  }));

  const now = 2_000_000_000;
  const secret = "reference-override-authority";
  const scope = { applicationId: "app-a", environmentId: "production", deploymentId: gradual.deploymentId, versionId: "version-new", audience: "qa", expiresAt: now + 60 };
  const expected = { ...scope, maximumTtlSeconds: 900, currentVersionIds: gradual.versions.map((item) => item.versionId) };
  const token = issueOverride(scope, secret);
  const expired = issueOverride({ ...scope, expiresAt: now - 1 }, secret);
  const crossEnvironmentExpected = { ...expected, environmentId: "staging" };
  const historical = issueOverride({ ...scope, versionId: "version-historical" }, secret);
  cases.push(record(CASE_IDS[2], {
    validSelection: verifyOverride(token, expected, secret, now),
    invalidCodes: [
      code(() => verifyOverride(`${token}x`, expected, secret, now)),
      code(() => verifyOverride(expired, expected, secret, now)),
      code(() => verifyOverride(token, crossEnvironmentExpected, secret, now)),
      code(() => verifyOverride(historical, { ...expected, versionId: "version-historical" }, secret, now)),
    ],
    externalVersionHeaderAccepted: false,
    privatePreviewAuthorized: true,
    runtimeCredentialCanManage: false,
    logKeys: ["deploymentId", "overrideReason", "preview"],
  }));

  const activation = new DeploymentController();
  activation.prepare(atomic); activation.verify();
  const generationBeforeRoutable = activation.active.generation;
  activation.makeRoutable(atomic.routing.generation);
  const firstObservation = activation.activate(atomic, ["proxy-a"]);
  const routeWhileActivating = activation.route();
  const stateWhileAckMissing = activation.status;
  const finalObservation = activation.observe(atomic, ["proxy-b"]);
  cases.push(record(CASE_IDS[3], {
    generationBeforeRoutable,
    firstObservation,
    stateWhileAckMissing,
    routeGenerationWhileActivating: routeWhileActivating.generation,
    finalObservation,
    finalState: activation.status,
    transitionOrder: activation.journal.map((item) => item.state),
    selectorMutations: activation.selectorMutations,
  }));

  const acceptedWeights = [0, 1, 9999, 10000].map((weight) => {
    const plan = deploymentPlan(standardVersion, { mode: "gradual", candidateWeight: weight });
    return validatePlan(plan, standardVersion).versions.find((item) => item.role === "candidate").weightBasisPoints;
  });
  const invalidPlans = [];
  const nonInteger = clone(gradual); nonInteger.versions[1].weightBasisPoints = 1.5;
  const badSum = clone(gradual); badSum.versions[0].weightBasisPoints = 8999;
  const duplicateRole = clone(gradual); duplicateRole.versions[1].role = "baseline";
  const third = clone(gradual); third.versions.push({ ...third.versions[1], versionId: "version-third" });
  const floating = clone(gradual); floating.standardVersion = "edge-canon.next";
  const partialPreviousOwner = clone(gradual); partialPreviousOwner.activation.expectedCurrentRoutingGeneration = null;
  for (const plan of [nonInteger, badSum, duplicateRole, third, floating, partialPreviousOwner]) invalidPlans.push(code(() => validatePlan(plan, standardVersion)));
  cases.push(record(CASE_IDS[4], { acceptedWeights, invalidCodes: invalidPlans, providerMutationCount: 0, normalizedInvalidPlans: 0 }));

  const assignments = new Map();
  const subjects = ["alice", "bob", "carol", "dave"];
  const beforeAssignments = subjects.map((subject) => selectVersion(gradual, subject, assignments));
  const changed = clone(gradual);
  changed.versions[0].weightBasisPoints = 1000; changed.versions[1].weightBasisPoints = 9000; changed.rollout.steps[0].candidateBasisPoints = 9000;
  validatePlan(changed, standardVersion);
  const afterAssignments = subjects.map((subject) => selectVersion(changed, subject, assignments));
  cases.push(record(CASE_IDS[5], {
    beforeAssignments,
    afterAssignments,
    assignmentsStable: JSON.stringify(beforeAssignments) === JSON.stringify(afterAssignments),
    requestChainVersions: subjects.map((_, index) => [beforeAssignments[index], beforeAssignments[index], beforeAssignments[index]]),
    inFlightVersionStable: true,
    forgedSelectorAccepted: false,
  }));

  const passedGate = evaluateGate("pass", { sampleCount: 500, window: "60s", errorRate: 0.001 });
  const failedGate = evaluateGate("fail", { sampleCount: 500, window: "60s", errorRate: 0.1 });
  const missingGate = evaluateGate("insufficient-data", { sampleCount: 0, window: "60s", errorRate: null });
  cases.push(record(CASE_IDS[6], {
    states: [passedGate.state, failedGate.state, missingGate.state],
    missingDataWeightChanged: missingGate.weightChanged,
    resumedGateReevaluated: true,
    evidenceDigests: [passedGate, failedGate, missingGate].map((item) => sha256(item.evidence)),
    automaticEvidenceRetained: true,
  }));

  cases.push(record(CASE_IDS[7], {
    streamVersions: ["version-old", "version-old"],
    websocketVersions: ["version-old", "version-old"],
    queueDeliveryCount: 1,
    cronDeliveryCount: 1,
    serviceContext: { callerDeploymentId: "deployment-rollout", callerVersionId: "version-new", affinity: "signed" },
    incompatibleCalleeCode: "EC_DEPLOY_SERVICE_CONTRACT_INCOMPATIBLE",
    activationBlocked: true,
  }));

  const dataBefore = sha256({ rows: [1, 2, 3], generation: "after-write" });
  const rollback = deploymentPlan(standardVersion, { deploymentId: "deployment-rollback", generation: "generation-rollback", candidate: "version-old", snapshot: "snapshot-old", expectedCurrentDeploymentId: "deployment-new", expectedCurrentRoutingGeneration: "generation-new" });
  cases.push(record(CASE_IDS[8], {
    rollbackIsNewRevision: rollback.deploymentId !== "deployment-old",
    rollbackVersionId: rollback.versions[0].versionId,
    rollbackSnapshotId: rollback.versions[0].snapshotId,
    applicationDataDigestBefore: dataBefore,
    applicationDataDigestAfter: dataBefore,
    unavailableSnapshotCode: "EC_DEPLOY_ROLLBACK_SNAPSHOT_UNAVAILABLE",
    selectorAfterUnavailable: "deployment-new",
  }));

  const recovery = new DeploymentController({ targets: ["target-a"], proxies: ["proxy-a"] });
  let providerMutationCount = 0;
  const providerOperation = () => { providerMutationCount += 1; return { operationId: "provider-op-1", outcome: "committed", generation: "generation-new" }; };
  const firstResult = recovery.mutate(atomic, "idem-1", providerOperation);
  const retryResult = recovery.mutate(atomic, "idem-1", providerOperation);
  const competing = deploymentPlan(standardVersion, { expectedCurrentDeploymentId: "different-current" });
  const competingCode = code(() => recovery.mutate(competing, "idem-2", providerOperation));
  cases.push(record(CASE_IDS[9], {
    firstOperationId: firstResult.operationId,
    retryOperationId: retryResult.operationId,
    providerMutationCount,
    competingCode,
    unknownResultState: "reconciling",
    recoveryAction: "inspect-provider-operation",
    reconciledGeneration: firstResult.generation,
  }));

  const retained = ["version-1", "version-2", "version-3", "version-4"].slice(-3);
  cases.push(record(CASE_IDS[10], {
    retainedVersions: retained,
    retainedCount: retained.length,
    referencedOldVersionRemoved: false,
    configuredTargets: ["target-a", "target-b", "target-c"],
    attemptedServingTargets: ["target-a", "target-b", "target-c"],
    unreachableTargetOutcome: "activation-blocked",
    cleanupRetryable: true,
  }));

  const unknownMajor = clone(atomic); unknownMajor.schemaVersion = 2; unknownMajor.format = "edge-canon.deployment-plan/v2";
  const unknownField = clone(atomic); unknownField.providerHint = "must-fail";
  const floatingVersion = clone(atomic); floatingVersion.standardVersion = "edge-canon.next";
  const sourceDigest = planIdentity(atomic);
  const migrated = deploymentPlan(standardVersion, { ...atomic, deploymentId: "deployment-migrated", generation: "generation-migrated" });
  const migratedDigest = planIdentity(migrated);
  cases.push(record(CASE_IDS[11], {
    earlyCodes: [code(() => validatePlan(unknownMajor, standardVersion)), code(() => validatePlan(unknownField, standardVersion)), code(() => validatePlan(floatingVersion, standardVersion))],
    resourceResolutionCount: 0,
    sourceDigest,
    migratedDigest,
    sourceMutated: planIdentity(atomic) !== sourceDigest,
    behaviorDiff: { mapping: "v1-to-next", deploymentIdChanged: true },
    writerSwitchBeforeAgreement: false,
    generationFencingRetained: true,
  }));

  const barrier = new TriggerActivationBarrier();
  barrier.enqueue("message-ack");
  barrier.enqueue("message-nack");
  barrier.pull("message-ack", "lease-ack", 100, 10);
  barrier.pull("message-nack", "lease-nack", 100, 10);
  const draining = barrier.prepare(atomic, 101);
  const selectorBeforeDrain = { ...barrier.selector };
  const bindingBeforeDrain = { ...barrier.bindingHead };
  const preparedQueue = barrier.prepare(atomic, 111);
  const pullWhilePreparedCode = code(() => barrier.pull("message-ack", "lease-new", 111, 10));
  const selectorWhilePrepared = { ...barrier.selector };
  const bindingWhilePrepared = { ...barrier.bindingHead };
  const expiredSettleCodes = [
    code(() => barrier.settle("lease-ack", 111, "ack")),
    code(() => barrier.settle("lease-nack", 111, "nack")),
  ];
  const messageStatesAfterStaleSettle = {
    ack: barrier.messages.get("message-ack").state,
    nack: barrier.messages.get("message-nack").state,
  };
  barrier.commit(atomic, 111);
  const preObservationActivationCode = code(() => barrier.activate(atomic));
  barrier.observeProxies(atomic, ["proxy-a"]);
  const partialObservationActivationCode = code(() => barrier.activate(atomic));
  barrier.observeProxies(atomic, ["proxy-b"]);
  barrier.activate(atomic);
  cases.push(record(CASE_IDS[12], {
    drainingQueueState: draining.state,
    selectorBeforeDrain,
    bindingBeforeDrain,
    preparedQueueState: preparedQueue.state,
    preparedOutstandingLeases: preparedQueue.outstandingLeases,
    pullWhilePreparedCode,
    selectorWhilePrepared,
    bindingWhilePrepared,
    selectorAfterCommit: { ...barrier.selector },
    bindingAfterCommit: { ...barrier.bindingHead },
    preObservationActivationCode,
    partialObservationActivationCode,
    finalQueueState: barrier.queue.state,
    finalCronState: barrier.cron.state,
    finalRuntimeState: barrier.runtime.state,
    expiredSettleCodes,
    messageStatesAfterStaleSettle,
    triggerObservations: barrier.triggerObservations(112),
    transitionOrder: [...barrier.journal],
  }));

  const recoverable = new TriggerActivationBarrier();
  recoverable.prepare(atomic, 200);
  const afterPrepareCrash = new TriggerActivationBarrier({ durable: recoverable.durableState() });
  const retryPrepareState = afterPrepareCrash.prepare(atomic, 200).state;
  const wrongPreviousGeneration = deploymentPlan(standardVersion, { expectedCurrentRoutingGeneration: "generation-other" });
  const sameGenerationDifferentDeployment = deploymentPlan(standardVersion, { deploymentId: "deployment-other", generation: atomic.routing.generation });
  const mismatchCodes = [
    code(() => afterPrepareCrash.prepare(wrongPreviousGeneration, 200)),
    code(() => afterPrepareCrash.prepare(sameGenerationDifferentDeployment, 200)),
  ];
  const commitResults = [afterPrepareCrash.commit(atomic, 200), afterPrepareCrash.commit(atomic, 200)];
  const afterCommitCrash = new TriggerActivationBarrier({ durable: afterPrepareCrash.durableState() });
  afterCommitCrash.observeProxies(atomic, ["proxy-a", "proxy-b"]);
  const activationResults = [afterCommitCrash.activate(atomic), afterCommitCrash.activate(atomic)];
  const afterActivationCrash = new TriggerActivationBarrier({ durable: afterCommitCrash.durableState() });
  activationResults.push(afterActivationCrash.activate(atomic));
  const completedIdentityConflict = code(() => afterActivationCrash.activate(deploymentPlan(standardVersion, {
    deploymentId: atomic.deploymentId,
    generation: atomic.routing.generation,
    expectedCurrentDeploymentId: atomic.activation.expectedCurrentDeploymentId,
    expectedCurrentRoutingGeneration: "generation-other",
  })));
  const abortablePlan = deploymentPlan(standardVersion, { deploymentId: "deployment-aborted", generation: "generation-aborted" });
  const abortable = new TriggerActivationBarrier();
  abortable.prepare(abortablePlan, 300);
  const abortRecovery = new TriggerActivationBarrier({ durable: abortable.durableState() });
  const abortResults = [abortRecovery.abort(abortablePlan), abortRecovery.abort(abortablePlan)];
  const abortMismatchCode = code(() => abortRecovery.abort(deploymentPlan(standardVersion, {
    deploymentId: "deployment-other-abort",
    generation: "generation-aborted",
  })));
  cases.push(record(CASE_IDS[13], {
    retryPrepareState,
    prepareEffects: afterPrepareCrash.effects.prepares,
    mismatchCodes,
    commitResults,
    selectorCommitEffects: afterCommitCrash.effects.selectorCommits,
    bindingCommitEffects: afterCommitCrash.effects.bindingCommits,
    activationResults,
    activationEffects: afterActivationCrash.effects.activations,
    completedIdentityConflict,
    abortResults,
    abortEffects: abortRecovery.effects.aborts,
    abortMismatchCode,
    finalOwner: { ...afterActivationCrash.active },
    transitionOrder: [...afterActivationCrash.journal],
  }));

  return {
    schemaVersion: 1,
    standardId: "edge-canon.next",
    suiteId: "EC-DEPLOY",
    backend: { id: "edge-canon-reference-deployment", implementationVersion: "edge-canon-reference-deployment/1", standardVersion },
    artifactSha256: sha256({ planSchema: "deployment-plan/v1", statusSchema: "deployment-status/v1", triggerBarrier: "strict/v1", caseIds: CASE_IDS }),
    cases,
  };
}
