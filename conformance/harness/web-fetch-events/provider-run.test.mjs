import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { adapterExitCode } from "./provider-adapter-cli.mjs";
import { deploymentStatePath } from "./provider-deployment.mjs";
import { runProvider, runStatePath } from "./provider-run.mjs";

const protocolVersion = "edge-canon.provider-adapter/v1";

function fixture(context, suffix) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".edge-canon-run-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidenceDirectory = path.join(root, "evidence");
  fs.mkdirSync(evidenceDirectory);
  return {
    manifest: {
      backendId: "deislet",
      protocolVersion,
    },
    request: {
      operation: "run",
      operationId: `run-${suffix}`,
      standardVersion: `edge-canon.next@${"1".repeat(40)}`,
      suiteId: "EC-WEB",
      canonicalArtifact: { path: path.join(root, "artifact.json"), sha256: "2".repeat(64) },
      workDirectory: root,
      evidenceDirectory,
      configuration: {},
    },
  };
}

function phaseResult(request, manifest, outcome = "succeeded", overrides = {}) {
  return {
    schemaVersion: 1,
    protocolVersion,
    operation: request.operation,
    operationId: request.operationId,
    backendId: manifest.backendId,
    outcome,
    mutatedRemoteState: ["deploy", "cleanup"].includes(request.operation),
    retrySafe: outcome !== "indeterminate",
    data: {},
    evidenceRefs: [],
    failure: outcome === "succeeded" ? null : {
      code: "EC_ADAPTER_TOOL_FAILED",
      message: `${request.operation} did not complete`,
    },
    ...overrides,
  };
}

test("run executes all phases once, persists a terminal result and replays it without side effects", async (context) => {
  const { request, manifest } = fixture(context, "success");
  const calls = [];
  const observationsPath = path.join(request.evidenceDirectory, "observations.json");
  const execute = async (name, phaseRequest) => {
    calls.push(name);
    return phaseResult(phaseRequest, manifest, "succeeded", name === "collect"
      ? { data: { observationsPath }, evidenceRefs: [observationsPath] }
      : {});
  };

  const first = await runProvider({ request, manifest, phase: execute });
  assert.equal(first.outcome, "succeeded");
  assert.equal(first.mutatedRemoteState, true);
  assert.equal(first.retrySafe, true);
  assert.equal(first.data.observationsPath, observationsPath);
  assert.deepEqual(calls, ["preflight", "prepare", "deploy", "invoke", "collect", "cleanup"]);
  assert.deepEqual(first.data.state.phaseResults.map((entry) => entry.phase), calls);
  assert.equal(fs.statSync(first.data.statePath).mode & 0o777, 0o600);

  calls.length = 0;
  const replay = await runProvider({ request, manifest, phase: execute });
  assert.equal(replay.outcome, "succeeded");
  assert.equal(replay.mutatedRemoteState, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(replay.data.state, first.data.state);
});

test("run attempts cleanup after a post-deploy failure and redacts credentials", async (context) => {
  const { request, manifest } = fixture(context, "failure");
  const calls = [];
  const secret = "run-secret-canary";
  const result = await runProvider({
    request,
    manifest,
    credentials: [secret],
    phase: async (name, phaseRequest) => {
      calls.push(name);
      if (name === "invoke") {
        const error = new Error(`invocation exposed ${secret}`);
        error.code = "EC_ADAPTER_INVOCATION_FAILED";
        throw error;
      }
      return phaseResult(phaseRequest, manifest);
    },
  });
  assert.equal(result.outcome, "failed");
  assert.equal(result.retrySafe, true);
  assert.deepEqual(calls, ["preflight", "prepare", "deploy", "invoke", "cleanup"]);
  assert.equal(result.failure.code, "EC_ADAPTER_INVOCATION_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /run-secret-canary/);
});

test("run attempts cleanup when deploy wrote recovery state before throwing", async (context) => {
  const { request, manifest } = fixture(context, "deploy-throw");
  const calls = [];
  const result = await runProvider({
    request,
    manifest,
    phase: async (name, phaseRequest) => {
      calls.push(name);
      if (name === "deploy") {
        fs.writeFileSync(deploymentStatePath(request, manifest), "deployment began\n", { mode: 0o600 });
        const error = new Error("provider result was lost");
        error.code = "EC_ADAPTER_TOOL_FAILED";
        throw error;
      }
      return phaseResult(phaseRequest, manifest);
    },
  });
  assert.equal(result.outcome, "failed");
  assert.deepEqual(calls, ["preflight", "prepare", "deploy", "cleanup"]);
});

test("an uncertain cleanup makes the whole run indeterminate", async (context) => {
  const { request, manifest } = fixture(context, "cleanup-indeterminate");
  const result = await runProvider({
    request,
    manifest,
    phase: async (name, phaseRequest) => phaseResult(
      phaseRequest,
      manifest,
      name === "cleanup" ? "indeterminate" : "succeeded",
    ),
  });
  assert.equal(result.outcome, "indeterminate");
  assert.equal(result.retrySafe, false);
  assert.equal(result.failure.code, "EC_ADAPTER_TOOL_FAILED");
});

test("a running state resumes at its first unfinished phase", async (context) => {
  const { request, manifest } = fixture(context, "resume");
  const timestamp = new Date().toISOString();
  const completed = ["preflight", "prepare", "deploy"].map((phase) => ({
    phase,
    completedAt: timestamp,
    result: phaseResult({ ...request, operation: phase }, manifest),
  }));
  const state = {
    schemaVersion: 1,
    stateFormat: "edge-canon.provider-run-state/v1",
    operationId: request.operationId,
    backendId: manifest.backendId,
    standardVersion: request.standardVersion,
    suiteId: request.suiteId,
    canonicalArtifactSha256: request.canonicalArtifact.sha256,
    status: "running",
    currentPhase: "invoke",
    phaseResults: completed,
    observationsPath: null,
    evidenceRefs: [],
    failure: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  fs.writeFileSync(runStatePath(request, manifest), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const calls = [];
  const result = await runProvider({
    request,
    manifest,
    phase: async (name, phaseRequest) => {
      calls.push(name);
      return phaseResult(phaseRequest, manifest);
    },
  });
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(calls, ["invoke", "collect", "cleanup"]);
  assert.deepEqual(
    result.data.state.phaseResults.map((entry) => entry.phase),
    ["preflight", "prepare", "deploy", "invoke", "collect", "cleanup"],
  );
});

test("only succeeded adapter results use exit status zero", () => {
  assert.equal(adapterExitCode({ outcome: "succeeded" }), 0);
  assert.equal(adapterExitCode({ outcome: "failed" }), 1);
  assert.equal(adapterExitCode({ outcome: "indeterminate" }), 1);
});
