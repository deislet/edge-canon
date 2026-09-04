import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildCanonicalArtifact, sha256 } from "./canonical-artifact.mjs";
import { runAdapter } from "./provider-adapter-cli.mjs";
import {
  cleanupProvider,
  deploymentStatePath,
  deployProvider,
  operationProjectName,
  ProviderDeploymentError,
} from "./provider-deployment.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const revision = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const standardVersion = `edge-canon.next@${revision}`;

function manifestPath(backendId) {
  return fileURLToPath(new URL(`./provider-adapters/${backendId}/adapter.json`, import.meta.url));
}

function manifest(backendId) {
  return JSON.parse(fs.readFileSync(manifestPath(backendId), "utf8"));
}

async function harness(context, backendId, operationId) {
  const root = fs.mkdtempSync(path.join(repositoryRoot, ".edge-canon-deployment-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonical = buildCanonicalArtifact({
    repositoryRoot,
    standardVersion,
    outputDirectory: path.join(root, "canonical"),
  });
  const workDirectory = path.join(root, "work");
  const evidenceDirectory = path.join(workDirectory, "evidence");
  const derivedDirectory = path.join(workDirectory, "derived");
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
    canonicalArtifact: {
      path: canonical.canonicalArtifactPath,
      sha256: canonical.canonicalArtifactSha256,
    },
    workDirectory,
    evidenceDirectory,
    configuration: {
      derivedDirectory,
      projectName,
      compatibilityDate: "2026-09-01",
      evidenceSinkUrl: "https://evidence.invalid/events",
      controlledOriginUrl: "https://origin.invalid",
      connectionBarrierOriginUrl: "https://barrier.invalid",
      cpuIterations: 10_000,
      calibratedCpuMilliseconds: 9,
      calibratedWorkSha256: sha256(fs.readFileSync(path.join(root, "canonical", "cpu-workload.mjs"))),
    },
  };
  await runAdapter({ manifestPath: manifestPath(backendId), request, hostEnvironment: {} });
  request.operation = "deploy";
  return { root, request, manifest: manifest(backendId) };
}

function execution(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    termination: null,
    stdout: "",
    stderr: "",
    durationMs: 7,
    ...overrides,
  };
}

function statusResponse(status, document) {
  return new Response(document === undefined ? "" : JSON.stringify(document), {
    status,
    headers: document === undefined ? undefined : { "content-type": "application/json" },
  });
}

test("Cloudflare deploy and cleanup bind one immutable identity without mutating the derived artifact", async (context) => {
  const setup = await harness(context, "cloudflare-workers-pages", "cf-lifecycle");
  const derivedManifest = fs.readFileSync(path.join(setup.request.configuration.derivedDirectory, "edge-canon-derived-artifact.json"));
  const hostEnvironment = {
    CLOUDFLARE_ACCOUNT_ID: "account-secret",
    CLOUDFLARE_API_TOKEN: "token-secret",
  };
  const environment = { ...hostEnvironment };
  const tool = { executable: process.execPath, baseArgs: ["/pinned/wrangler.js"] };
  const fetchStatuses = [404, 200, 404];
  const fetchImpl = async () => statusResponse(fetchStatuses.shift());
  let deployCalls = 0;
  let cleanupCalls = 0;
  const processRunner = async (options) => {
    assert.equal(options.environment.CLOUDFLARE_API_TOKEN, "token-secret");
    assert.deepEqual(options.credentialEnvironment, ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
    assert.doesNotMatch(options.args.join(" "), /account-secret|token-secret/);
    if (options.args.includes("deploy")) {
      deployCalls += 1;
      fs.writeFileSync(options.environment.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify({
        type: "deploy",
        version: 1,
        worker_name: setup.request.configuration.projectName,
        version_id: "cf-version-1",
        targets: ["https://edge-canon-cf.example.workers.dev"],
        wrangler_environment: "production",
      })}\n`);
      return execution({ stdout: "deployed\n" });
    }
    cleanupCalls += 1;
    assert.deepEqual(options.args.slice(-3), ["delete", setup.request.configuration.projectName, "--force"]);
    return execution({ stdout: "deleted\n" });
  };

  const deployed = await deployProvider({ ...setup, tool, environment, hostEnvironment, processRunner, fetchImpl });
  assert.equal(deployed.outcome, "succeeded");
  assert.equal(deployed.mutatedRemoteState, true);
  assert.equal(deployed.data.state.status, "deployed");
  assert.equal(deployed.data.state.provider.versionId, "cf-version-1");
  assert.equal(fs.statSync(deployed.data.statePath).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readFileSync(path.join(setup.request.configuration.derivedDirectory, "edge-canon-derived-artifact.json")),
    derivedManifest,
  );
  assert.equal(fs.existsSync(path.join(setup.request.configuration.derivedDirectory, ".wrangler")), false);

  const repeated = await deployProvider({ ...setup, tool, environment, hostEnvironment, processRunner, fetchImpl });
  assert.equal(repeated.outcome, "succeeded");
  assert.equal(repeated.mutatedRemoteState, false);
  assert.equal(deployCalls, 1);

  setup.request.operation = "cleanup";
  const cleaned = await cleanupProvider({ ...setup, tool, environment, hostEnvironment, processRunner, fetchImpl });
  assert.equal(cleaned.outcome, "succeeded");
  assert.equal(cleaned.data.state.status, "cleaned");
  assert.equal(cleanupCalls, 1);
  const cleanedAgain = await cleanupProvider({ ...setup, tool, environment, hostEnvironment, processRunner, fetchImpl });
  assert.equal(cleanedAgain.mutatedRemoteState, false);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(fetchStatuses, []);
});

test("a remote name collision is refused before a deployment state or mutable input exists", async (context) => {
  const setup = await harness(context, "cloudflare-workers-pages", "cf-collision");
  const hostEnvironment = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" };
  let processCalls = 0;
  await assert.rejects(
    deployProvider({
      ...setup,
      tool: { executable: process.execPath, baseArgs: ["/pinned/wrangler.js"] },
      environment: { ...hostEnvironment },
      hostEnvironment,
      processRunner: async () => { processCalls += 1; return execution(); },
      fetchImpl: async () => statusResponse(200),
    }),
    (error) => error instanceof ProviderDeploymentError && error.code === "EC_ADAPTER_RESOURCE_CONFLICT",
  );
  assert.equal(processCalls, 0);
  assert.equal(fs.existsSync(path.join(setup.request.workDirectory, ".edge-canon-provider-input")), false);
  const stateRoot = path.join(setup.request.workDirectory, ".edge-canon-provider-state", setup.request.backendId);
  assert.deepEqual(fs.readdirSync(stateRoot), []);
});

test("an uncertain deploy is persisted and never blindly repeated", async (context) => {
  const setup = await harness(context, "cloudflare-workers-pages", "cf-timeout");
  const hostEnvironment = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" };
  let processCalls = 0;
  let fetchCalls = 0;
  const options = {
    ...setup,
    tool: { executable: process.execPath, baseArgs: ["/pinned/wrangler.js"] },
    environment: { ...hostEnvironment },
    hostEnvironment,
    processRunner: async () => {
      processCalls += 1;
      return execution({ exitCode: null, signal: "SIGKILL", termination: "timeout" });
    },
    fetchImpl: async () => { fetchCalls += 1; return statusResponse(404); },
  };
  const first = await deployProvider(options);
  assert.equal(first.outcome, "indeterminate");
  assert.equal(first.retrySafe, false);
  assert.equal(first.data.state.status, "deploy-indeterminate");
  const repeated = await deployProvider(options);
  assert.equal(repeated.outcome, "indeterminate");
  assert.equal(repeated.mutatedRemoteState, false);
  assert.equal(processCalls, 1);
  assert.equal(fetchCalls, 1);
});

test("concurrent deploy callers cannot execute the provider command twice", async (context) => {
  const setup = await harness(context, "cloudflare-workers-pages", "cf-concurrent");
  const hostEnvironment = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" };
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let finishResolve;
  const finish = new Promise((resolve) => { finishResolve = resolve; });
  let processCalls = 0;
  const first = deployProvider({
    ...setup,
    tool: { executable: process.execPath, baseArgs: ["/pinned/wrangler.js"] },
    environment: { ...hostEnvironment },
    hostEnvironment,
    fetchImpl: async () => statusResponse(404),
    processRunner: async (options) => {
      processCalls += 1;
      enteredResolve();
      await finish;
      fs.writeFileSync(options.environment.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify({
        type: "deploy",
        worker_name: setup.request.configuration.projectName,
        version_id: "concurrent-version",
        targets: ["https://concurrent.example.workers.dev"],
      })}\n`);
      return execution();
    },
  });
  await entered;
  await assert.rejects(
    deployProvider({
      ...setup,
      tool: { executable: process.execPath, baseArgs: ["/pinned/wrangler.js"] },
      environment: { ...hostEnvironment },
      hostEnvironment,
      fetchImpl: async () => statusResponse(404),
      processRunner: async () => { processCalls += 1; return execution(); },
    }),
    (error) => error instanceof ProviderDeploymentError && error.code === "EC_ADAPTER_OPERATION_BUSY",
  );
  finishResolve();
  assert.equal((await first).outcome, "succeeded");
  assert.equal(processCalls, 1);
  assert.equal(fs.existsSync(`${deploymentStatePath(setup.request, setup.manifest)}.lock`), false);
});

test("an exact deployment input left before state persistence is safely reused", async (context) => {
  const setup = await harness(context, "cloudflare-workers-pages", "cf-recover-input");
  const statePath = deploymentStatePath(setup.request, setup.manifest);
  const key = path.basename(statePath, ".json");
  const recoveredInput = path.join(
    setup.request.workDirectory,
    ".edge-canon-provider-input",
    `${setup.request.backendId}-${key}`,
  );
  fs.mkdirSync(path.dirname(recoveredInput), { recursive: true });
  fs.cpSync(setup.request.configuration.derivedDirectory, recoveredInput, { recursive: true, errorOnExist: true });
  const hostEnvironment = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" };
  const result = await deployProvider({
    ...setup,
    tool: { executable: process.execPath, baseArgs: ["/pinned/wrangler.js"] },
    environment: { ...hostEnvironment },
    hostEnvironment,
    fetchImpl: async () => statusResponse(404),
    processRunner: async (options) => {
      fs.writeFileSync(options.environment.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify({
        type: "deploy",
        worker_name: setup.request.configuration.projectName,
        version_id: "recovered-version",
        targets: ["https://recovered.example.workers.dev"],
      })}\n`);
      return execution();
    },
  });
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.data.state.provider.versionId, "recovered-version");
});

test("a recovered deployment input with different bytes is never deployed", async (context) => {
  const setup = await harness(context, "cloudflare-workers-pages", "cf-recover-mismatch");
  const statePath = deploymentStatePath(setup.request, setup.manifest);
  const key = path.basename(statePath, ".json");
  const recoveredInput = path.join(
    setup.request.workDirectory,
    ".edge-canon-provider-input",
    `${setup.request.backendId}-${key}`,
  );
  fs.mkdirSync(path.dirname(recoveredInput), { recursive: true });
  fs.cpSync(setup.request.configuration.derivedDirectory, recoveredInput, { recursive: true, errorOnExist: true });
  fs.appendFileSync(path.join(recoveredInput, "wrangler.json"), "changed");
  const hostEnvironment = { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" };
  let processCalls = 0;
  await assert.rejects(
    deployProvider({
      ...setup,
      tool: { executable: process.execPath, baseArgs: ["/pinned/wrangler.js"] },
      environment: { ...hostEnvironment },
      hostEnvironment,
      fetchImpl: async () => statusResponse(404),
      processRunner: async () => { processCalls += 1; return execution(); },
    }),
    (error) => error instanceof ProviderDeploymentError && error.code === "EC_ADAPTER_STATE_INVALID",
  );
  assert.equal(processCalls, 0);
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(fs.existsSync(`${statePath}.lock`), false);
});

test("an EdgeOne identity response body is covered by the remote timeout", async (context) => {
  const setup = await harness(context, "tencent-edgeone-makers", "eo-query-timeout");
  Object.assign(setup.request.configuration, {
    deploymentEnvironment: "production",
    area: "global",
    apiRegion: "global",
  });
  setup.manifest.security.timeoutSeconds = 0.01;
  const hostEnvironment = { EDGEONE_PAGES_API_TOKEN: "edgeone-secret" };
  const neverEndingBody = new ReadableStream({ pull() {} });
  await assert.rejects(
    deployProvider({
      ...setup,
      tool: { executable: process.execPath, baseArgs: ["/pinned/edgeone.js"] },
      environment: { ...hostEnvironment },
      hostEnvironment,
      fetchImpl: async () => new Response(neverEndingBody, { status: 200 }),
      processRunner: async () => execution(),
    }),
    (error) => error instanceof ProviderDeploymentError && error.code === "EC_ADAPTER_REMOTE_QUERY_FAILED",
  );
});

test("Deislet deploy maps its standard credential and cleanup uses the protected Control API", async (context) => {
  const setup = await harness(context, "deislet", "deis-lifecycle");
  Object.assign(setup.request.configuration, {
    controlUrl: "http://127.0.0.1:18085",
    runtimeUrl: "http://127.0.0.1:18088",
    environmentName: "conformance",
  });
  const hostEnvironment = {
    DEIS_DEPLOY_TOKEN: "deis-deploy-secret",
    DEIS_ADMIN_TOKEN: "deis-admin-secret",
  };
  const environment = { DEIS_DEPLOY_TOKEN: "deis-deploy-secret" };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push([String(url), options.method ?? "GET", options.headers?.Authorization]);
    if ((options.method ?? "GET") === "DELETE") {
      return statusResponse(200, {
        app_id: setup.request.configuration.projectName,
        unloaded: { unloaded: ["node-1"], failed: [], skipped: null },
        retained: {},
      });
    }
    return statusResponse(calls.length === 1 || calls.length === 4 ? 404 : 200, {});
  };
  let deployCalls = 0;
  const processRunner = async (options) => {
    deployCalls += 1;
    assert.equal(options.environment.DEIS_CONTROL_TOKEN, "deis-deploy-secret");
    assert.equal(options.environment.DEIS_DEPLOY_TOKEN, undefined);
    assert.equal(options.environment.DEIS_ADMIN_TOKEN, undefined);
    assert.deepEqual(options.credentialEnvironment, ["DEIS_CONTROL_TOKEN"]);
    return execution({
      stdout: `${JSON.stringify({
        app: setup.request.configuration.projectName,
        environment: "conformance",
        version: { id: "deis-version-1" },
        deployment: { id: "deis-deployment-1" },
      })}\n`,
    });
  };
  const deployed = await deployProvider({
    ...setup,
    tool: { executable: "/absolute/deis", baseArgs: [] },
    environment,
    hostEnvironment,
    processRunner,
    fetchImpl,
  });
  assert.equal(deployed.outcome, "succeeded");
  assert.equal(deployed.data.state.provider.url, "http://127.0.0.1:18088/");
  setup.request.operation = "cleanup";
  const cleaned = await cleanupProvider({
    ...setup,
    tool: { executable: "/absolute/deis", baseArgs: [] },
    environment: { DEIS_ADMIN_TOKEN: "deis-admin-secret" },
    hostEnvironment,
    processRunner,
    fetchImpl,
  });
  assert.equal(cleaned.outcome, "succeeded");
  assert.equal(cleaned.data.state.status, "cleaned");
  assert.equal(deployCalls, 1);
  assert.deepEqual(calls.map((entry) => entry[1]), ["GET", "GET", "DELETE", "GET"]);
  assert.equal(calls[0][2], "Bearer deis-deploy-secret");
  assert.deepEqual(calls.slice(1).map((entry) => entry[2]), Array(3).fill("Bearer deis-admin-secret"));
});

test("Deislet cleanup remains indeterminate when a runtime node did not unload the deleted app", async (context) => {
  const setup = await harness(context, "deislet", "deis-partial-cleanup");
  Object.assign(setup.request.configuration, {
    controlUrl: "http://127.0.0.1:18085",
    runtimeUrl: "http://127.0.0.1:18088",
    environmentName: "conformance",
  });
  const hostEnvironment = {
    DEIS_DEPLOY_TOKEN: "deis-deploy-secret",
    DEIS_ADMIN_TOKEN: "deis-admin-secret",
  };
  const tool = { executable: "/absolute/deis", baseArgs: [] };
  const deployFetch = async () => statusResponse(404);
  await deployProvider({
    ...setup,
    tool,
    environment: { DEIS_DEPLOY_TOKEN: "deis-deploy-secret" },
    hostEnvironment,
    fetchImpl: deployFetch,
    processRunner: async () => execution({
      stdout: `${JSON.stringify({
        app: setup.request.configuration.projectName,
        environment: "conformance",
        version: { id: "version-partial" },
        deployment: { id: "deployment-partial" },
      })}\n`,
    }),
  });

  setup.request.operation = "cleanup";
  let calls = 0;
  const partialFetch = async (_url, options = {}) => {
    calls += 1;
    if ((options.method ?? "GET") === "DELETE") {
      return statusResponse(200, {
        app_id: setup.request.configuration.projectName,
        unloaded: { unloaded: [], failed: [{ node: "node-1", error: "offline" }], skipped: null },
        retained: {},
      });
    }
    return statusResponse(200, {});
  };
  const partial = await cleanupProvider({
    ...setup,
    tool,
    environment: { DEIS_ADMIN_TOKEN: "deis-admin-secret" },
    hostEnvironment,
    fetchImpl: partialFetch,
  });
  assert.equal(partial.outcome, "indeterminate");
  assert.equal(partial.data.state.status, "cleanup-indeterminate");

  const retry = await cleanupProvider({
    ...setup,
    tool,
    environment: { DEIS_ADMIN_TOKEN: "deis-admin-secret" },
    hostEnvironment,
    fetchImpl: partialFetch,
  });
  assert.equal(retry.outcome, "indeterminate");
  assert.equal(retry.mutatedRemoteState, false);
  assert.equal(retry.data.state.status, "cleanup-indeterminate");
  assert.equal(calls, 3);
});

test("EdgeOne deploy records the CLI project and deployment identities", async (context) => {
  const setup = await harness(context, "tencent-edgeone-makers", "eo-lifecycle");
  Object.assign(setup.request.configuration, {
    deploymentEnvironment: "production",
    area: "global",
    apiRegion: "global",
  });
  const hostEnvironment = { EDGEONE_PAGES_API_TOKEN: "edgeone-secret" };
  let requestBody;
  const result = await deployProvider({
    ...setup,
    tool: { executable: process.execPath, baseArgs: ["/pinned/edgeone.js"] },
    environment: { ...hostEnvironment },
    hostEnvironment,
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return statusResponse(200, { Data: { Response: { Projects: [] } } });
    },
    processRunner: async (options) => {
      assert.equal(options.environment.EDGEONE_PAGES_API_REGION, "global");
      assert.doesNotMatch(options.args.join(" "), /edgeone-secret/);
      return execution({
        stdout: `progress\n${JSON.stringify({
          status: "success",
          url: "https://edgeone-deployment.example",
          projectId: "pages-project-1",
          deploymentId: "deployment-1",
        })}\n`,
      });
    },
  });
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.data.state.provider.projectId, "pages-project-1");
  assert.equal(result.data.state.provider.deploymentId, "deployment-1");
  assert.equal(requestBody.Filters[0].Values[0], setup.request.configuration.projectName);
});
