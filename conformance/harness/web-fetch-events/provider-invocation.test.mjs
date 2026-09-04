import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildCanonicalArtifact, sha256 } from "./canonical-artifact.mjs";
import { deployProvider, operationProjectName } from "./provider-deployment.mjs";
import { invokeProvider, invocationStatePath } from "./provider-invocation.mjs";
import { runAdapter } from "./provider-adapter-cli.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const revision = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const standardVersion = `edge-canon.next@${revision}`;
const backendId = "cloudflare-workers-pages";
const manifestPath = fileURLToPath(new URL(`./provider-adapters/${backendId}/adapter.json`, import.meta.url));

async function setupHarness(context, operationId) {
  const root = fs.mkdtempSync(path.join(repositoryRoot, ".edge-canon-invocation-test-"));
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
      evidenceSinkUrl: "https://evidence.test/events",
      controlledOriginUrl: "https://origin.test",
      connectionBarrierOriginUrl: "https://barrier.test",
      cpuIterations: 10_000,
    },
  };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  await runAdapter({ manifestPath, request, hostEnvironment: {} });
  request.operation = "deploy";
  const deployEnvironment = {
    CLOUDFLARE_ACCOUNT_ID: "account-secret",
    CLOUDFLARE_API_TOKEN: "deploy-secret",
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
  request.operation = "invoke";
  return { request, manifest };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function standardError() {
  return new Response("Internal Server Error\n", {
    status: 500,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function fullFetchDouble() {
  let providerCalls = 0;
  let controlCalls = 0;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === "origin.test" || url.hostname === "barrier.test") {
      controlCalls += 1;
      if (url.pathname.endsWith("/origin/status")) {
        return json({
          directIndices: Array.from({ length: 48 }, (_, index) => index),
          redirectRequestCount: 1,
          redirectTargetCount: 1,
          totalRequestCount: 50,
        });
      }
      if (url.pathname.endsWith("/barrier/status")) {
        return json({ waitingSlots: [0, 1, 2, 3, 4, 5], startedSlots: [0, 1, 2, 3, 4, 5], cancelledSlots: [] });
      }
      return json({ ok: true });
    }
    assert.equal(url.hostname, "worker.test");
    providerCalls += 1;
    assert.match(options.headers["x-edge-canon-invocation-id"], /^ecw-[0-9a-f]{40}$/);
    assert.equal(options.headers["x-edge-canon-evidence-token"], "evidence_token_123456789012345678901234");
    switch (url.pathname) {
      case "/cpu":
        assert.equal(options.headers["x-edge-canon-evidence-mode"], "off");
        return json({ completionSentinel: "cpu-work-complete", checksum: 123 });
      case "/sync": return new Response("edge-canon-sync");
      case "/context": return json({
        contextKeys: ["env", "params", "request", "waitUntil"],
        contextObjectIdentityUnique: true,
        environment: "edge-canon-env",
        parameter: "edge-canon-param",
      });
      case "/transport-headers": return json({ evidenceMode: null, evidenceToken: null, invocationId: null });
      case "/method": return new Response(`${options.method}:${options.body ?? ""}`);
      case "/throw-sync":
      case "/throw-async":
      case "/invalid-undefined":
      case "/invalid-string":
      case "/invalid-object": return standardError();
      case "/concurrent": return json({
        marker: url.searchParams.get("marker"),
        contextObjectIdentityUnique: true,
        moduleCounterSample: providerCalls,
      });
      case "/stream": return new Response(new ReadableStream({
        start(controller) {
          for (const part of ["stream-one", "stream-two", "stream-three"]) {
            controller.enqueue(new TextEncoder().encode(part));
          }
          controller.close();
        },
      }));
      case "/background": return new Response("background-response");
      case "/capture-wait-until": return new Response("wait-until-captured");
      case "/disconnect": return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first:disconnect-one"));
        },
        cancel() {},
      }));
      case "/probe": return new Response("probe:probe-two");
      case "/subrequests":
        assert.equal(options.headers["x-edge-canon-evidence-mode"], "off");
        return json({ completionSentinel: "fifty-subrequests-complete", fetchCallCount: 49 });
      case "/connections": return json({ markers: Array.from({ length: 7 }, (_, index) => `connection-${index}`) });
      case "/request-body-limit": {
        const body = Buffer.from(options.body);
        assert.equal(body.byteLength, 1_000_000);
        return json({
          contentEncoding: null,
          declaredContentLength: options.headers["content-length"],
          firstOctet: body[0],
          lastOctet: body.at(-1),
          receivedByteLength: body.byteLength,
          receivedSha256: sha256(body),
        });
      }
      default: throw new Error(`unexpected provider path ${url.pathname}`);
    }
  };
  return {
    fetchImpl,
    counts: () => ({ providerCalls, controlCalls }),
  };
}

test("invoke executes the exact provider-neutral plan once and binds immutable raw evidence", async (context) => {
  const setup = await setupHarness(context, "invoke-complete");
  const double = fullFetchDouble();
  const environment = { EDGE_CANON_EVIDENCE_TOKEN: "evidence_token_123456789012345678901234" };
  const first = await invokeProvider({ ...setup, environment, fetchImpl: double.fetchImpl });
  assert.equal(first.outcome, "succeeded");
  assert.equal(first.data.state.status, "invoked");
  assert.equal(first.data.state.completedSteps.length, 16);
  assert.deepEqual(double.counts(), { providerCalls: 28, controlCalls: 5 });
  assert.equal(fs.statSync(first.data.statePath).mode & 0o777, 0o600);
  const evidencePath = path.join(setup.request.evidenceDirectory, first.data.state.rawEvidenceFile);
  assert.equal(fs.statSync(evidencePath).mode & 0o777, 0o600);
  const evidenceBytes = fs.readFileSync(evidencePath);
  assert.equal(sha256(evidenceBytes), first.data.state.rawEvidenceSha256);
  assert.doesNotMatch(evidenceBytes.toString("utf8"), /evidence_token_123456789012345678901234/);
  const records = evidenceBytes.toString("utf8").trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 16);
  assert.equal(records[0].stepId, "cpu");
  assert.equal(records[0].data.exchange.request.pathname, "/cpu");
  assert.equal(records.at(-1).stepId, "request-body-limit");

  const repeated = await invokeProvider({ ...setup, environment, fetchImpl: double.fetchImpl });
  assert.equal(repeated.outcome, "succeeded");
  assert.equal(repeated.mutatedRemoteState, false);
  assert.deepEqual(double.counts(), { providerCalls: 28, controlCalls: 5 });
});

test("an uncertain HTTP exchange is persisted and never replayed", async (context) => {
  const setup = await setupHarness(context, "invoke-indeterminate");
  const environment = { EDGE_CANON_EVIDENCE_TOKEN: "evidence_token_123456789012345678901234" };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("socket outcome is unknown");
  };
  const first = await invokeProvider({ ...setup, environment, fetchImpl });
  assert.equal(first.outcome, "indeterminate");
  assert.equal(first.retrySafe, false);
  assert.equal(first.data.state.status, "invoke-indeterminate");
  assert.equal(calls, 1);
  const stateBytes = fs.readFileSync(invocationStatePath(setup.request, setup.manifest), "utf8");
  assert.doesNotMatch(stateBytes, /socket outcome is unknown/);

  const repeated = await invokeProvider({ ...setup, environment, fetchImpl });
  assert.equal(repeated.outcome, "indeterminate");
  assert.equal(repeated.mutatedRemoteState, false);
  assert.equal(calls, 1);
});

test("invoke through the protocol does not require or probe a provider CLI", async (context) => {
  const setup = await setupHarness(context, "invoke-no-cli");
  const double = fullFetchDouble();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = double.fetchImpl;
  try {
    const result = await runAdapter({
      manifestPath,
      request: setup.request,
      hostEnvironment: { EDGE_CANON_EVIDENCE_TOKEN: "evidence_token_123456789012345678901234" },
    });
    assert.equal(result.outcome, "succeeded");
    assert.equal(Object.hasOwn(setup.request.configuration, "toolEntrypoint"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
