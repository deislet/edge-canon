import crypto from "node:crypto";
import { planIdentity, sha256 } from "./fixture.mjs";

const EXACT_STANDARD = /^edge-canon\.next@[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const STATES = new Set(["created", "preparing", "prepared", "verifying", "ready", "activating", "active", "paused", "progressing", "aborting", "rolled-back", "failed", "degraded", "reconciling"]);
const TRANSITIONS = new Map([
  ["created", new Set(["preparing", "failed"])],
  ["preparing", new Set(["prepared", "failed", "reconciling"])],
  ["prepared", new Set(["verifying", "failed"])],
  ["verifying", new Set(["ready", "paused", "failed"])],
  ["ready", new Set(["activating", "failed"])],
  ["activating", new Set(["active", "degraded", "reconciling"])],
  ["progressing", new Set(["paused", "active", "aborting", "degraded"])],
  ["paused", new Set(["progressing", "aborting"])],
  ["aborting", new Set(["rolled-back", "reconciling"])],
  ["degraded", new Set(["reconciling", "aborting"])],
  ["reconciling", new Set(["activating", "active", "failed", "rolled-back"])],
]);

export class DeploymentError extends Error {
  constructor(code) { super(code); this.name = "DeploymentError"; this.code = code; }
}

function fail(code) { throw new DeploymentError(code); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, allowed, required, code = "EC_DEPLOY_DOCUMENT_INVALID") {
  if (!object(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) fail(code);
}
function identity(value) { return typeof value === "string" && IDENTITY.test(value); }

export function captureCode(operation) {
  try { operation(); return null; } catch (error) { return error instanceof DeploymentError ? error.code : `UNEXPECTED_${error.name}`; }
}

export function validatePlan(plan, expectedStandardVersion, counters = {}) {
  counters.validation = (counters.validation ?? 0) + 1;
  exactKeys(plan, ["$schema", "schemaVersion", "format", "standardVersion", "deploymentId", "environmentId", "mode", "versions", "routing", "rollout", "activation"], ["schemaVersion", "format", "standardVersion", "deploymentId", "environmentId", "mode", "versions", "routing", "rollout", "activation"]);
  if (plan.schemaVersion !== 1 || plan.format !== "edge-canon.deployment-plan/v1") fail("EC_DEPLOY_VERSION_UNSUPPORTED");
  if (!EXACT_STANDARD.test(plan.standardVersion) || plan.standardVersion !== expectedStandardVersion) fail("EC_DEPLOY_STANDARD_PIN_INVALID");
  if (!identity(plan.deploymentId) || !identity(plan.environmentId) || !new Set(["atomic", "gradual"]).has(plan.mode)) fail("EC_DEPLOY_DOCUMENT_INVALID");
  if (!Array.isArray(plan.versions) || plan.versions.length < 1 || plan.versions.length > 2) fail("EC_DEPLOY_VERSION_COUNT_INVALID");
  const roles = new Set();
  let total = 0;
  for (const version of plan.versions) {
    exactKeys(version, ["role", "versionId", "artifactSha256", "snapshotId", "weightBasisPoints"], ["role", "versionId", "artifactSha256", "snapshotId", "weightBasisPoints"]);
    if (!new Set(["baseline", "candidate"]).has(version.role) || roles.has(version.role)) fail("EC_DEPLOY_ROLE_INVALID");
    if (!identity(version.versionId) || !identity(version.snapshotId) || typeof version.artifactSha256 !== "string" || !SHA256.test(version.artifactSha256)) fail("EC_DEPLOY_IDENTITY_INVALID");
    if (!Number.isInteger(version.weightBasisPoints) || version.weightBasisPoints < 0 || version.weightBasisPoints > 10000) fail("EC_DEPLOY_WEIGHT_INVALID");
    roles.add(version.role); total += version.weightBasisPoints;
  }
  if (!roles.has("candidate") || total !== 10000) fail("EC_DEPLOY_WEIGHT_INVALID");
  if (plan.mode === "atomic" && (plan.versions.length !== 1 || plan.versions[0].role !== "candidate" || plan.versions[0].weightBasisPoints !== 10000)) fail("EC_DEPLOY_ATOMIC_PLAN_INVALID");
  if (plan.mode === "gradual" && (plan.versions.length !== 2 || !roles.has("baseline"))) fail("EC_DEPLOY_GRADUAL_PLAN_INVALID");
  exactKeys(plan.routing, ["generation", "affinity", "override"], ["generation", "affinity", "override"]);
  if (!identity(plan.routing.generation)) fail("EC_DEPLOY_IDENTITY_INVALID");
  exactKeys(plan.routing.affinity, ["mode", "saltSha256", "weightChange"], ["mode", "saltSha256", "weightChange"]);
  if (plan.routing.affinity.mode !== "rollout-stable" || !SHA256.test(plan.routing.affinity.saltSha256) || !new Set(["sticky", "re-evaluate"]).has(plan.routing.affinity.weightChange)) fail("EC_DEPLOY_AFFINITY_INVALID");
  exactKeys(plan.routing.override, ["mode", "maximumTtlSeconds"], ["mode", "maximumTtlSeconds"]);
  if (plan.routing.override.mode !== "signed-expiring-scope-restricted" || !Number.isInteger(plan.routing.override.maximumTtlSeconds) || plan.routing.override.maximumTtlSeconds < 1 || plan.routing.override.maximumTtlSeconds > 86400) fail("EC_DEPLOY_OVERRIDE_POLICY_INVALID");
  exactKeys(plan.rollout, ["currentStep", "steps"], ["currentStep", "steps"]);
  if (!Number.isInteger(plan.rollout.currentStep) || plan.rollout.currentStep < 0 || !Array.isArray(plan.rollout.steps) || plan.rollout.steps.length < 1 || plan.rollout.currentStep >= plan.rollout.steps.length) fail("EC_DEPLOY_ROLLOUT_INVALID");
  for (const step of plan.rollout.steps) {
    exactKeys(step, ["candidateBasisPoints", "soakSeconds", "gateIds"], ["candidateBasisPoints", "soakSeconds", "gateIds"]);
    if (!Number.isInteger(step.candidateBasisPoints) || step.candidateBasisPoints < 0 || step.candidateBasisPoints > 10000 || !Number.isInteger(step.soakSeconds) || step.soakSeconds < 0 || !Array.isArray(step.gateIds) || new Set(step.gateIds).size !== step.gateIds.length || step.gateIds.some((item) => !identity(item))) fail("EC_DEPLOY_ROLLOUT_INVALID");
  }
  const candidate = plan.versions.find((item) => item.role === "candidate");
  if (candidate.weightBasisPoints !== plan.rollout.steps[plan.rollout.currentStep].candidateBasisPoints) fail("EC_DEPLOY_WEIGHT_INVALID");
  exactKeys(plan.activation, ["expectedCurrentDeploymentId", "expectedCurrentRoutingGeneration", "servingPolicy", "drainSeconds", "emergency"], ["expectedCurrentDeploymentId", "expectedCurrentRoutingGeneration", "servingPolicy", "drainSeconds", "emergency"]);
  const previousIdentityValid = plan.activation.expectedCurrentDeploymentId === null
    ? plan.activation.expectedCurrentRoutingGeneration === null
    : identity(plan.activation.expectedCurrentDeploymentId) && identity(plan.activation.expectedCurrentRoutingGeneration);
  if (!previousIdentityValid || plan.activation.servingPolicy !== "all-configured-targets-ready" || !Number.isInteger(plan.activation.drainSeconds) || plan.activation.drainSeconds < 0 || plan.activation.drainSeconds > 86400 || typeof plan.activation.emergency !== "boolean") fail("EC_DEPLOY_ACTIVATION_POLICY_INVALID");
  return Object.freeze(structuredClone(plan));
}

export class PlanStore {
  #plans = new Map();
  #versions = new Map();
  constructor(active = { deploymentId: "deployment-old", generation: "generation-old" }) { this.production = { ...active }; }
  upload(version) { const id = sha256(version); this.#versions.set(id, structuredClone(version)); return id; }
  create(plan, standardVersion) { const value = validatePlan(plan, standardVersion); const digest = planIdentity(value); this.#plans.set(digest, value); return digest; }
  get(digest) { return structuredClone(this.#plans.get(digest)); }
  mutateStored(digest, operation) {
    const copy = this.get(digest);
    operation(copy);
    return planIdentity(copy) !== digest && planIdentity(this.get(digest)) === digest;
  }
}

export class DeploymentController {
  constructor({ activeDeploymentId = "deployment-old", activeGeneration = "generation-old", targets = ["target-a", "target-b", "target-c"], proxies = ["proxy-a", "proxy-b"] } = {}) {
    this.active = { deploymentId: activeDeploymentId, generation: activeGeneration };
    this.targets = [...targets]; this.proxies = [...proxies]; this.status = "created"; this.sequence = 0;
    this.targetStates = new Map(targets.map((id) => [id, "pending"]));
    this.proxyStates = new Map(proxies.map((id) => [id, "pending"]));
    this.providerOperations = new Map(); this.selectorMutations = 0; this.assignments = new Map(); this.journal = [];
  }
  transition(expected, next) {
    if (this.status !== expected) fail("EC_DEPLOY_STATE_CONFLICT");
    if (!STATES.has(next) || !TRANSITIONS.get(expected)?.has(next)) fail("EC_DEPLOY_TRANSITION_INVALID");
    this.status = next; this.sequence += 1; this.journal.push({ sequence: this.sequence, state: next });
  }
  prepare(plan, resultByTarget = {}) {
    this.transition("created", "preparing");
    for (const target of this.targets) this.targetStates.set(target, resultByTarget[target] === false ? "failed" : "prepared");
    if ([...this.targetStates.values()].some((state) => state === "failed")) { this.transition("preparing", "failed"); return false; }
    this.transition("preparing", "prepared"); return true;
  }
  verify(passed = true) {
    this.transition("prepared", "verifying");
    this.transition("verifying", passed ? "ready" : "failed");
    if (passed) for (const target of this.targets) this.targetStates.set(target, "verified");
    return passed;
  }
  makeRoutable(generation) {
    if (this.status !== "ready") fail("EC_DEPLOY_NOT_READY");
    for (const target of this.targets) this.targetStates.set(target, `routable:${generation}`);
  }
  activate(plan, acknowledgedProxies = []) {
    const generation = plan.routing.generation;
    if (this.status !== "ready" || this.targets.some((target) => this.targetStates.get(target) !== `routable:${generation}`)) fail("EC_DEPLOY_NOT_ROUTABLE");
    if (this.active.deploymentId !== plan.activation.expectedCurrentDeploymentId || this.active.generation !== plan.activation.expectedCurrentRoutingGeneration) fail("EC_DEPLOY_ACTIVATION_CONFLICT");
    this.transition("ready", "activating");
    this.active = { deploymentId: plan.deploymentId, generation }; this.selectorMutations += 1;
    for (const proxy of acknowledgedProxies) if (this.proxyStates.has(proxy)) this.proxyStates.set(proxy, `active:${generation}`);
    return this.observe(plan);
  }
  observe(plan, extraAcknowledgements = []) {
    for (const proxy of extraAcknowledgements) if (this.proxyStates.has(proxy)) this.proxyStates.set(proxy, `active:${plan.routing.generation}`);
    const allAck = this.proxies.every((proxy) => this.proxyStates.get(proxy) === `active:${plan.routing.generation}`);
    if (allAck && this.status === "activating") {
      for (const target of this.targets) this.targetStates.set(target, `active:${plan.routing.generation}`);
      this.transition("activating", "active");
    }
    return allAck;
  }
  route() {
    const eligible = this.targets.filter((target) => ["routable", "active"].some((prefix) => this.targetStates.get(target).startsWith(`${prefix}:${this.active.generation}`)));
    if (eligible.length === 0) fail("EC_DEPLOY_NO_TARGET_FOR_GENERATION");
    return { target: eligible[0], generation: this.active.generation };
  }
  mutate(plan, idempotencyKey, providerOperation) {
    const operationIdentity = JSON.stringify({
      deploymentId: plan.deploymentId,
      generation: plan.routing.generation,
      previousDeploymentId: plan.activation.expectedCurrentDeploymentId,
      previousGeneration: plan.activation.expectedCurrentRoutingGeneration,
    });
    if (this.active.deploymentId !== plan.activation.expectedCurrentDeploymentId || this.active.generation !== plan.activation.expectedCurrentRoutingGeneration) fail("EC_DEPLOY_ACTIVATION_CONFLICT");
    if (this.providerOperations.has(idempotencyKey)) {
      const stored = this.providerOperations.get(idempotencyKey);
      if (stored.operationIdentity !== operationIdentity) fail("EC_DEPLOY_IDEMPOTENCY_CONFLICT");
      return stored.result;
    }
    const result = providerOperation(); this.providerOperations.set(idempotencyKey, { operationIdentity, result }); return result;
  }
}

function planOwner(plan) {
  return { deploymentId: plan.deploymentId, generation: plan.routing.generation };
}
function previousOwner(plan) {
  return {
    deploymentId: plan.activation.expectedCurrentDeploymentId,
    generation: plan.activation.expectedCurrentRoutingGeneration,
  };
}
function sameOwner(left, right) {
  return left?.deploymentId === right?.deploymentId && left?.generation === right?.generation;
}
function candidateSnapshot(plan) {
  return plan.versions.find((version) => version.role === "candidate").snapshotId;
}

export class TriggerActivationBarrier {
  constructor({
    activeDeploymentId = "deployment-old",
    activeGeneration = "generation-old",
    activeSnapshotId = "snapshot-old",
    proxies = ["proxy-a", "proxy-b"],
    durable = null,
  } = {}) {
    if (durable) {
      this.active = cloneRecord(durable.active);
      this.selector = cloneRecord(durable.selector);
      this.bindingHead = cloneRecord(durable.bindingHead);
      this.pending = cloneRecord(durable.pending);
      this.lastPrevious = cloneRecord(durable.lastPrevious);
      this.completed = cloneRecord(durable.completed);
      this.lastAborted = cloneRecord(durable.lastAborted);
      this.proxyObservationRecordedFor = cloneRecord(durable.proxyObservationRecordedFor);
      this.queue = cloneRecord(durable.queue);
      this.cron = cloneRecord(durable.cron);
      this.runtime = cloneRecord(durable.runtime);
      this.proxyStates = new Map(durable.proxyStates);
      this.messages = new Map(durable.messages);
      this.leases = new Map(durable.leases);
      this.journal = structuredClone(durable.journal);
      this.effects = cloneRecord(durable.effects);
      return;
    }
    this.active = { deploymentId: activeDeploymentId, generation: activeGeneration };
    this.selector = { ...this.active };
    this.bindingHead = { ...this.active, snapshotId: activeSnapshotId };
    this.pending = null;
    this.lastPrevious = null;
    this.completed = null;
    this.lastAborted = null;
    this.proxyObservationRecordedFor = null;
    this.queue = { state: "active", owner: { ...this.active }, workAdmissionOpen: true, outstandingLeases: 0 };
    this.cron = { state: "active", owner: { ...this.active }, workAdmissionOpen: true };
    this.runtime = { state: "active", owner: { ...this.active }, workAdmissionOpen: true };
    this.proxyStates = new Map(proxies.map((proxyId) => [proxyId, { deploymentId: activeDeploymentId, generation: activeGeneration }]));
    this.messages = new Map();
    this.leases = new Map();
    this.journal = [];
    this.effects = { prepares: 0, selectorCommits: 0, bindingCommits: 0, activations: 0, aborts: 0, settlements: 0 };
  }

  durableState() {
    return structuredClone({
      active: this.active,
      selector: this.selector,
      bindingHead: this.bindingHead,
      pending: this.pending,
      lastPrevious: this.lastPrevious,
      completed: this.completed,
      lastAborted: this.lastAborted,
      proxyObservationRecordedFor: this.proxyObservationRecordedFor,
      queue: this.queue,
      cron: this.cron,
      runtime: this.runtime,
      proxyStates: [...this.proxyStates],
      messages: [...this.messages],
      leases: [...this.leases],
      journal: this.journal,
      effects: this.effects,
    });
  }

  enqueue(messageId) {
    if (!identity(messageId) || this.messages.has(messageId)) fail("EC_DEPLOY_QUEUE_MESSAGE_INVALID");
    this.messages.set(messageId, { state: "available" });
  }

  pull(messageId, leaseId, now, leaseSeconds) {
    this.#refreshExpired(now);
    if (!this.queue.workAdmissionOpen) fail("EC_DEPLOY_QUEUE_PULL_FENCED");
    if (!Number.isFinite(now) || !Number.isInteger(leaseSeconds) || leaseSeconds < 1 || !identity(leaseId)) fail("EC_DEPLOY_QUEUE_LEASE_INVALID");
    const message = this.messages.get(messageId);
    if (!message || message.state !== "available") fail("EC_DEPLOY_QUEUE_MESSAGE_UNAVAILABLE");
    const lease = { messageId, owner: { ...this.queue.owner }, expiresAt: now + leaseSeconds, state: "leased" };
    this.leases.set(leaseId, lease);
    this.messages.set(messageId, { state: "leased", leaseId });
    return leaseId;
  }

  settle(leaseId, now, disposition) {
    if (!new Set(["ack", "nack"]).has(disposition)) fail("EC_DEPLOY_QUEUE_SETTLEMENT_INVALID");
    this.#refreshExpired(now);
    const lease = this.leases.get(leaseId);
    if (!lease || lease.state !== "leased" || lease.expiresAt <= now) fail("EC_DEPLOY_QUEUE_LEASE_STALE");
    const message = this.messages.get(lease.messageId);
    if (!message || message.state !== "leased" || message.leaseId !== leaseId) fail("EC_DEPLOY_QUEUE_LEASE_STALE");
    this.leases.set(leaseId, { ...lease, state: "settled" });
    this.messages.delete(lease.messageId);
    this.effects.settlements += 1;
    this.#refreshQueueState(now);
    return true;
  }

  prepare(plan, now) {
    const candidate = planOwner(plan);
    const previous = previousOwner(plan);
    if (sameOwner(this.active, candidate) && this.completed) {
      if (!sameOwner(this.completed.candidate, candidate) || !sameOwner(this.completed.previous, previous)) fail("EC_DEPLOY_ACTIVATION_CONFLICT");
      return this.queueObservation();
    }
    if (!sameOwner(this.active, previous) || !sameOwner(this.selector, previous) || !sameOwner(this.bindingHead, previous)) fail("EC_DEPLOY_ACTIVATION_CONFLICT");
    if (this.pending) {
      if (!sameOwner(this.pending.candidate, candidate) || !sameOwner(this.pending.previous, previous)) fail("EC_DEPLOY_ACTIVATION_CONFLICT");
      this.#refreshQueueState(now);
      return this.queueObservation();
    }
    this.pending = { candidate, previous, snapshotId: candidateSnapshot(plan), committed: false };
    this.lastPrevious = { ...previous };
    this.queue = { state: "draining", owner: { ...previous }, workAdmissionOpen: false, outstandingLeases: 0 };
    this.cron = { state: "prepared", owner: { ...candidate }, workAdmissionOpen: false };
    this.runtime = { state: "prepared", owner: { ...candidate }, workAdmissionOpen: false };
    this.effects.prepares += 1;
    this.journal.push("trigger-prepare");
    this.#refreshQueueState(now);
    return this.queueObservation();
  }

  commit(plan, now) {
    const candidate = planOwner(plan);
    const previous = previousOwner(plan);
    this.#refreshQueueState(now);
    if (sameOwner(this.selector, candidate) && sameOwner(this.bindingHead, candidate) && this.bindingHead.snapshotId === candidateSnapshot(plan)) {
      const operation = this.pending ?? this.completed;
      if (!operation || !sameOwner(operation.candidate, candidate) || !sameOwner(operation.previous, previous)) fail("EC_DEPLOY_ACTIVATION_CONFLICT");
      return false;
    }
    if (!this.pending || !sameOwner(this.pending.candidate, candidate) || !sameOwner(this.pending.previous, previous)) fail("EC_DEPLOY_TRIGGER_NOT_PREPARED");
    if (this.queue.state !== "prepared" || this.queue.outstandingLeases !== 0 || this.queue.workAdmissionOpen) fail("EC_DEPLOY_QUEUE_DRAIN_INCOMPLETE");
    if (!sameOwner(this.selector, previous) || !sameOwner(this.bindingHead, previous)) fail("EC_DEPLOY_ACTIVATION_CONFLICT");
    this.selector = { ...candidate };
    this.bindingHead = { ...candidate, snapshotId: this.pending.snapshotId };
    this.pending.committed = true;
    this.effects.selectorCommits += 1;
    this.effects.bindingCommits += 1;
    this.journal.push("production-commit");
    return true;
  }

  observeProxies(plan, proxyIds) {
    const candidate = planOwner(plan);
    if (!sameOwner(this.selector, candidate)) fail("EC_DEPLOY_PRODUCTION_NOT_COMMITTED");
    for (const proxyId of proxyIds) {
      if (!this.proxyStates.has(proxyId)) fail("EC_DEPLOY_PROXY_UNKNOWN");
      this.proxyStates.set(proxyId, { ...candidate });
    }
    if (this.proxiesObserved(plan) && !sameOwner(this.proxyObservationRecordedFor, candidate)) {
      this.proxyObservationRecordedFor = { ...candidate };
      this.journal.push("proxy-observed");
    }
    return this.proxiesObserved(plan);
  }

  proxiesObserved(plan) {
    const candidate = planOwner(plan);
    return [...this.proxyStates.values()].every((owner) => sameOwner(owner, candidate));
  }

  activate(plan) {
    const candidate = planOwner(plan);
    const previous = previousOwner(plan);
    if (sameOwner(this.active, candidate) && sameOwner(this.queue.owner, candidate) && this.queue.state === "active") {
      if (!this.completed || !sameOwner(this.completed.candidate, candidate) || !sameOwner(this.completed.previous, previous)) fail("EC_DEPLOY_ACTIVATION_CONFLICT");
      return false;
    }
    if (!this.pending || !this.pending.committed || !sameOwner(this.pending.candidate, candidate) || !sameOwner(this.pending.previous, previous)) fail("EC_DEPLOY_TRIGGER_NOT_PREPARED");
    if (!sameOwner(this.selector, candidate) || !sameOwner(this.bindingHead, candidate)) fail("EC_DEPLOY_PRODUCTION_NOT_COMMITTED");
    if (!this.proxiesObserved(plan)) fail("EC_DEPLOY_PROXY_OBSERVATION_INCOMPLETE");
    this.queue = { state: "active", owner: { ...candidate }, workAdmissionOpen: true, outstandingLeases: 0 };
    this.cron = { state: "active", owner: { ...candidate }, workAdmissionOpen: true };
    this.runtime = { state: "active", owner: { ...candidate }, workAdmissionOpen: true };
    this.active = { ...candidate };
    this.completed = structuredClone(this.pending);
    this.pending = null;
    this.effects.activations += 1;
    this.journal.push("trigger-activate");
    return true;
  }

  abort(plan) {
    const candidate = planOwner(plan);
    const previous = previousOwner(plan);
    if (!this.pending) {
      if (this.lastAborted && sameOwner(this.lastAborted.candidate, candidate) && sameOwner(this.lastAborted.previous, previous)) return false;
      fail("EC_DEPLOY_ABORT_CONFLICT");
    }
    if (!sameOwner(this.pending.candidate, candidate) || !sameOwner(this.pending.previous, previous)) fail("EC_DEPLOY_ABORT_CONFLICT");
    if (this.pending.committed) fail("EC_DEPLOY_RECONCILE_REQUIRED");
    this.queue = { state: "active", owner: { ...previous }, workAdmissionOpen: true, outstandingLeases: this.queue.outstandingLeases };
    this.cron = { state: "active", owner: { ...previous }, workAdmissionOpen: true };
    this.runtime = { state: "active", owner: { ...previous }, workAdmissionOpen: true };
    this.lastAborted = structuredClone(this.pending);
    this.pending = null;
    this.effects.aborts += 1;
    this.journal.push("trigger-abort");
    return true;
  }

  queueObservation() {
    return structuredClone(this.queue);
  }

  triggerObservations(now = 0) {
    const previous = this.pending?.previous ?? this.lastPrevious;
    const candidate = this.pending?.candidate ?? this.completed?.candidate ?? this.active;
    const observation = (triggerId, kind, trigger) => ({
      triggerId,
      kind,
      state: trigger.state,
      candidate: candidate ? { deploymentId: candidate.deploymentId, routingGeneration: candidate.generation } : null,
      previousOwner: previous ? { deploymentId: previous.deploymentId, routingGeneration: previous.generation } : null,
      observedOwner: trigger.owner ? { deploymentId: trigger.owner.deploymentId, routingGeneration: trigger.owner.generation } : null,
      workAdmissionOpen: trigger.workAdmissionOpen,
      outstandingLeases: kind === "queue" ? trigger.outstandingLeases : null,
      observedAt: new Date(now * 1000).toISOString(),
      failureCode: null,
    });
    return [
      observation("production-http", "http", this.runtime),
      observation("production-queue", "queue", this.queue),
      observation("production-cron", "cron", this.cron),
    ];
  }

  #refreshExpired(now) {
    for (const [leaseId, lease] of this.leases) {
      if (lease.state !== "leased" || lease.expiresAt > now) continue;
      const message = this.messages.get(lease.messageId);
      if (message?.state === "leased" && message.leaseId === leaseId) this.messages.set(lease.messageId, { state: "available" });
      this.leases.set(leaseId, { ...lease, state: "expired" });
    }
  }

  #refreshQueueState(now) {
    this.#refreshExpired(now);
    if (!this.pending) return;
    const previous = this.pending.previous;
    const outstandingLeases = [...this.leases.values()].filter((lease) => lease.state === "leased" && sameOwner(lease.owner, previous)).length;
    this.queue.outstandingLeases = outstandingLeases;
    this.queue.state = outstandingLeases === 0 ? "prepared" : "draining";
  }
}

function cloneRecord(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function tokenBody(scope) { return Buffer.from(JSON.stringify(scope)).toString("base64url"); }
export function issueOverride(scope, secret) { const body = tokenBody(scope); return `${body}.${crypto.createHmac("sha256", secret).update(body).digest("base64url")}`; }
export function verifyOverride(token, expected, secret, nowSeconds) {
  try {
    const [body, signature] = token.split(".");
    const wanted = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    if (!signature || signature.length !== wanted.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(wanted))) fail("EC_DEPLOY_OVERRIDE_INVALID");
    const scope = JSON.parse(Buffer.from(body, "base64url"));
    for (const key of ["applicationId", "environmentId", "deploymentId", "versionId", "audience"]) if (scope[key] !== expected[key]) fail("EC_DEPLOY_OVERRIDE_SCOPE_MISMATCH");
    if (!Number.isInteger(scope.expiresAt) || scope.expiresAt <= nowSeconds || scope.expiresAt - nowSeconds > expected.maximumTtlSeconds) fail("EC_DEPLOY_OVERRIDE_EXPIRED");
    if (!expected.currentVersionIds.includes(scope.versionId)) fail("EC_DEPLOY_OVERRIDE_VERSION_INVALID");
    return scope.versionId;
  } catch (error) { if (error instanceof DeploymentError) throw error; fail("EC_DEPLOY_OVERRIDE_INVALID"); }
}

export function selectVersion(plan, subject, assignments = new Map()) {
  const key = `${plan.routing.generation}:${subject}`;
  if (plan.routing.affinity.weightChange === "sticky" && assignments.has(key)) return assignments.get(key);
  const bucket = Number.parseInt(sha256(`${plan.routing.generation}:${subject}:${plan.routing.affinity.saltSha256}`).slice(0, 8), 16) % 10000;
  let cursor = 0; let selected = plan.versions.at(-1).versionId;
  for (const version of plan.versions) { cursor += version.weightBasisPoints; if (bucket < cursor) { selected = version.versionId; break; } }
  assignments.set(key, selected); return selected;
}

export function evaluateGate(outcome, evidence) {
  if (!new Set(["pass", "fail", "insufficient-data"]).has(outcome) || !object(evidence) || !Number.isInteger(evidence.sampleCount) || evidence.sampleCount < 0) fail("EC_DEPLOY_GATE_EVIDENCE_INVALID");
  return { state: outcome === "pass" ? "progressing" : outcome === "fail" ? "aborting" : "paused", weightChanged: outcome === "pass", evidence: structuredClone(evidence) };
}
