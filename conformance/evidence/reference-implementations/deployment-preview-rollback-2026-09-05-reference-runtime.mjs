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
  exactKeys(plan.activation, ["expectedCurrentDeploymentId", "servingPolicy", "drainSeconds", "emergency"], ["expectedCurrentDeploymentId", "servingPolicy", "drainSeconds", "emergency"]);
  if (!(plan.activation.expectedCurrentDeploymentId === null || identity(plan.activation.expectedCurrentDeploymentId)) || plan.activation.servingPolicy !== "all-configured-targets-ready" || !Number.isInteger(plan.activation.drainSeconds) || plan.activation.drainSeconds < 0 || plan.activation.drainSeconds > 86400 || typeof plan.activation.emergency !== "boolean") fail("EC_DEPLOY_ACTIVATION_POLICY_INVALID");
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
    if (this.active.deploymentId !== plan.activation.expectedCurrentDeploymentId) fail("EC_DEPLOY_ACTIVATION_CONFLICT");
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
  mutate(expectedDeploymentId, idempotencyKey, providerOperation) {
    if (this.active.deploymentId !== expectedDeploymentId) fail("EC_DEPLOY_ACTIVATION_CONFLICT");
    if (this.providerOperations.has(idempotencyKey)) return this.providerOperations.get(idempotencyKey);
    const result = providerOperation(); this.providerOperations.set(idempotencyKey, result); return result;
  }
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
