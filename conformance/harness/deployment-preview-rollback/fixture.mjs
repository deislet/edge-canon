import crypto from "node:crypto";

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(stableValue(value)), "utf8");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function planIdentity(plan) {
  return sha256(plan);
}

export function deploymentPlan(standardVersion, options = {}) {
  const mode = options.mode ?? "atomic";
  const candidateWeight = options.candidateWeight ?? (mode === "atomic" ? 10000 : 1000);
  const versions = options.versions ?? (mode === "atomic"
    ? [{ role: "candidate", versionId: options.candidate ?? "version-new", artifactSha256: sha256("artifact-new"), snapshotId: options.snapshot ?? "snapshot-new", weightBasisPoints: 10000 }]
    : [
        { role: "baseline", versionId: "version-old", artifactSha256: sha256("artifact-old"), snapshotId: "snapshot-old", weightBasisPoints: 10000 - candidateWeight },
        { role: "candidate", versionId: options.candidate ?? "version-new", artifactSha256: sha256("artifact-new"), snapshotId: options.snapshot ?? "snapshot-new", weightBasisPoints: candidateWeight },
      ]);
  const expectedCurrentDeploymentId = Object.hasOwn(options, "expectedCurrentDeploymentId") ? options.expectedCurrentDeploymentId : "deployment-old";
  const expectedCurrentRoutingGeneration = Object.hasOwn(options, "expectedCurrentRoutingGeneration") ? options.expectedCurrentRoutingGeneration : "generation-old";
  return {
    $schema: "https://github.com/deislet/edge-canon/schemas/deployment-plan.schema.json",
    schemaVersion: 1,
    format: "edge-canon.deployment-plan/v1",
    standardVersion,
    deploymentId: options.deploymentId ?? "deployment-new",
    environmentId: options.environmentId ?? "production",
    mode,
    versions,
    routing: {
      generation: options.generation ?? "generation-new",
      affinity: { mode: "rollout-stable", saltSha256: sha256("rollout-salt"), weightChange: "sticky" },
      override: { mode: "signed-expiring-scope-restricted", maximumTtlSeconds: 900 },
    },
    rollout: { currentStep: options.currentStep ?? 0, steps: options.steps ?? [{ candidateBasisPoints: candidateWeight, soakSeconds: 60, gateIds: ["error-rate"] }] },
    activation: {
      expectedCurrentDeploymentId,
      expectedCurrentRoutingGeneration,
      servingPolicy: "all-configured-targets-ready",
      drainSeconds: 30,
      emergency: options.emergency ?? false,
    },
  };
}
