import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildCanonicalArtifact, sha256 } from "./canonical-artifact.mjs";
import { startHarnessService } from "./harness-service.mjs";
import { verifyDocument } from "./oracle.mjs";
import { runAdapter } from "./provider-adapter-cli.mjs";
import { collectProvider, ProviderCollectionError } from "./provider-collection.mjs";
import { deployProvider, operationProjectName } from "./provider-deployment.mjs";
import { invokeProvider, providerInvocationId } from "./provider-invocation.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const revision = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const standardVersion = `edge-canon.next@${revision}`;
const backendId = "cloudflare-workers-pages";
const manifestPath = fileURLToPath(new URL(`./provider-adapters/${backendId}/adapter.json`, import.meta.url));
const token = "collection_evidence_token_123456789012345678901234";

async function setup(context, operationId) {
  const root = fs.mkdtempSync(path.join(repositoryRoot, ".edge-canon-collection-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = await startHarnessService({
    stateDirectory: path.join(root, "harness-state"),
    token,
  });
  context.after(() => service.close());
  const canonical = buildCanonicalArtifact({
    repositoryRoot,
    standardVersion,
    outputDirectory: path.join(root, "canonical"),
  });
  const workDirectory = path.join(root, "work");
  const evidenceDirectory = path.join(workDirectory, "evidence");
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const projectName = operationProjectName(backendId, operationId);
  const request = {
    schemaVersion: 1,
    protocolVersion: "edge-canon.provider-adapter/v1",
    operation: "prepare",
    operationId,
    standardVersion,
    suiteId: "EC-WEB",
    backendId,
    canonicalArtifact: { path: canonical.canonicalArtifactPath, sha256: canonical.canonicalArtifactSha256 },
    workDirectory,
    evidenceDirectory,
    configuration: {
      derivedDirectory: path.join(workDirectory, "derived"),
      projectName,
      compatibilityDate: "2026-09-01",
      evidenceSinkUrl: service.evidenceSinkUrl,
      controlledOriginUrl: service.controlledOriginUrl,
      connectionBarrierOriginUrl: service.connectionBarrierOriginUrl,
      cpuIterations: 10_000,
      calibratedCpuMilliseconds: 9,
      calibratedWorkSha256: sha256(fs.readFileSync(path.join(root, "canonical", "cpu-workload.mjs"))),
    },
  };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  await runAdapter({ manifestPath, request, hostEnvironment: {} });
  request.operation = "deploy";
  const deployEnvironment = {
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    CLOUDFLARE_API_TOKEN: "test-token",
  };
  await deployProvider({
    request,
    manifest,
    tool: { executable: process.execPath, baseArgs: ["/pinned/wrangler.mjs"] },
    environment: { ...deployEnvironment },
    hostEnvironment: deployEnvironment,
    fetchImpl: async () => new Response(null, { status: 404 }),
    processRunner: async (options) => {
      fs.writeFileSync(options.environment.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify({
        type: "deploy",
        worker_name: projectName,
        version_id: `version-${operationId}`,
        targets: ["https://worker.test"],
      })}\n`);
      return { exitCode: 0, signal: null, termination: null, stdout: "deployed", stderr: "", durationMs: 1 };
    },
  });
  const module = await import(`${pathToFileURL(path.join(request.configuration.derivedDirectory, "src/index.mjs")).href}?operation=${operationId}`);
  const retained = [];
  let sinkQueries = 0;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname !== "worker.test") {
      if (url.pathname === "/events" && (options.method ?? "GET") === "GET") sinkQueries += 1;
      return fetch(input, options);
    }
    const executionContext = {
      waitUntil(promise) {
        retained.push(Promise.resolve(promise));
      },
    };
    return module.default.fetch(new Request(url, options), {}, executionContext);
  };
  request.operation = "invoke";
  const environment = { EDGE_CANON_EVIDENCE_TOKEN: token };
  const originalLog = console.log;
  console.log = (line, ...rest) => {
    if (!(typeof line === "string" && line.startsWith("EDGE_CANON_EVIDENCE "))) originalLog(line, ...rest);
  };
  let invocation;
  try {
    invocation = await invokeProvider({ request, manifest, environment, fetchImpl });
  } finally {
    console.log = originalLog;
  }
  assert.equal(invocation.outcome, "succeeded");
  request.operation = "collect";
  return {
    request,
    manifest,
    environment,
    fetchImpl,
    retained,
    sinkQueries: () => sinkQueries,
  };
}

test("collection turns immutable transport and service facts into oracle-ready observations", async (context) => {
  const harness = await setup(context, "collection-complete");
  let cpuCollections = 0;
  const cpuCollector = async ({ request }) => {
    cpuCollections += 1;
    return {
      schemaVersion: 1,
      backendId,
      invocationId: providerInvocationId(request.operationId, "EC-WEB-T012", "cpu"),
      measurementKind: "backend-cpu",
      measuredCpuMilliseconds: 9.25,
      resourceFailureCode: null,
      providerEvidence: { source: "test-runtime", unit: "milliseconds" },
    };
  };
  const first = await collectProvider({ ...harness, cpuCollector, pollIntervalMs: 1 });
  assert.equal(first.outcome, "succeeded");
  assert.equal(first.mutatedRemoteState, false);
  assert.equal(cpuCollections, 1);
  assert.equal(fs.statSync(first.data.observationsPath).mode & 0o777, 0o600);
  const observations = JSON.parse(fs.readFileSync(first.data.observationsPath, "utf8"));
  assert.deepEqual(verifyDocument(observations), {
    suiteId: "EC-WEB",
    status: "pass",
    caseIds: Array.from({ length: 15 }, (_, index) => `EC-WEB-T${String(index + 1).padStart(3, "0")}`),
  });
  assert.equal(observations.cases[1].data.transportHeadersRemoved, true);
  assert.equal(observations.cases[11].data.measurementKind, "backend-cpu");
  assert.ok(observations.cases.every((record) => record.evidenceRefs.length >= 2));

  const queriesAfterFirst = harness.sinkQueries();
  const repeated = await collectProvider({ ...harness, cpuCollector, pollIntervalMs: 1 });
  assert.equal(repeated.data.state.observationsSha256, first.data.state.observationsSha256);
  assert.equal(cpuCollections, 1);
  assert.equal(harness.sinkQueries(), queriesAfterFirst);
  await Promise.allSettled(harness.retained);
});

test("collection refuses CPU wall time and does not write observations", async (context) => {
  const harness = await setup(context, "collection-wall-time");
  await assert.rejects(
    collectProvider({
      ...harness,
      pollIntervalMs: 1,
      cpuCollector: async ({ request }) => ({
        schemaVersion: 1,
        backendId,
        invocationId: providerInvocationId(request.operationId, "EC-WEB-T012", "cpu"),
        measurementKind: "wall-time",
        measuredCpuMilliseconds: 9,
        resourceFailureCode: null,
        providerEvidence: { source: "clock" },
      }),
    }),
    (error) => error instanceof ProviderCollectionError && error.code === "EC_ADAPTER_CPU_EVIDENCE_INVALID",
  );
  assert.equal(fs.readdirSync(harness.request.evidenceDirectory).some((name) => name.endsWith("-observations.json")), false);
  await Promise.allSettled(harness.retained);
});
