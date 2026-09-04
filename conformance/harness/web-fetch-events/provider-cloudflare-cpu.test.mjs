import assert from "node:assert/strict";
import test from "node:test";

import { ProviderCollectionError } from "./provider-collection.mjs";
import { createCloudflareCpuCollector } from "./provider-cloudflare-cpu.mjs";
import { providerInvocationId } from "./provider-invocation.mjs";

function context(fetchImpl, rayId = "1234567890abcdef-SIN") {
  const operationId = "cloudflare-cpu-test";
  return {
    request: {
      operationId,
      configuration: { projectName: "edge-canon-cf-test" },
    },
    manifest: {
      backendId: "cloudflare-workers-pages",
      security: { timeoutSeconds: 300 },
    },
    environment: {
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      CLOUDFLARE_API_TOKEN: "cloudflare-secret-token",
    },
    invocation: {
      deployment: { provider: { versionId: "version-one" } },
    },
    rawRecord: {
      observedAt: "2026-09-04T10:00:00.000Z",
      data: { exchange: { response: { headers: { "cf-ray": rayId } } } },
    },
    fetchImpl,
    deadlineAt: Date.now() + 5_000,
  };
}

function telemetry(events) {
  return new Response(JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result: { events: { count: events.length, events } },
  }), { headers: { "content-type": "application/json" } });
}

test("Cloudflare CPU collection polls by Ray ID and returns exact invocation CPU", async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(String(url), "https://api.cloudflare.com/client/v4/accounts/account-id/workers/observability/telemetry/query");
    assert.equal(options.headers.authorization, "Bearer cloudflare-secret-token");
    const query = JSON.parse(options.body);
    assert.equal(query.view, "events");
    assert.deepEqual(query.parameters.datasets, ["cloudflare-workers"]);
    assert.deepEqual(query.parameters.filters.map((filter) => [filter.key, filter.value]), [
      ["$metadata.rayId", "1234567890abcdef-SIN"],
      ["$metadata.service", "edge-canon-cf-test"],
    ]);
    if (calls === 1) return telemetry([]);
    return telemetry([{
      timestamp: 1788516000000,
      dataset: "cloudflare-workers",
      source: {},
      $metadata: { id: "event-one", rayId: "1234567890abcdef-SIN", service: "edge-canon-cf-test" },
      $workers: {
        cpuTimeMs: 9.4,
        wallTimeMs: 14,
        eventType: "fetch",
        outcome: "ok",
        requestId: "request-one",
        scriptName: "edge-canon-cf-test",
        scriptVersion: { id: "version-one" },
      },
    }]);
  };
  const result = await createCloudflareCpuCollector({ pollIntervalMs: 0 })(context(fetchImpl));
  assert.equal(calls, 2);
  assert.equal(result.measuredCpuMilliseconds, 9.4);
  assert.equal(result.measurementKind, "backend-cpu");
  assert.equal(result.resourceFailureCode, null);
  assert.equal(result.invocationId, providerInvocationId("cloudflare-cpu-test", "EC-WEB-T012", "cpu"));
  assert.doesNotMatch(JSON.stringify(result), /cloudflare-secret-token/);
});

test("Cloudflare CPU collection refuses an ambiguous Ray result", async () => {
  const event = {
    $metadata: { rayId: "1234567890abcdef-SIN", service: "edge-canon-cf-test" },
    $workers: { cpuTimeMs: 9, outcome: "ok", scriptName: "edge-canon-cf-test", scriptVersion: { id: "version-one" } },
  };
  await assert.rejects(
    createCloudflareCpuCollector({ pollIntervalMs: 0 })(context(async () => telemetry([event, structuredClone(event)]))),
    (error) => error instanceof ProviderCollectionError && error.code === "EC_ADAPTER_CPU_EVIDENCE_INVALID",
  );
});

test("Cloudflare CPU collection requires a response Ray ID before querying telemetry", async () => {
  let calls = 0;
  await assert.rejects(
    createCloudflareCpuCollector({ pollIntervalMs: 0 })(context(async () => {
      calls += 1;
      return telemetry([]);
    }, null)),
    (error) => error instanceof ProviderCollectionError && error.code === "EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE",
  );
  assert.equal(calls, 0);
});
