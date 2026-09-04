import assert from "node:assert/strict";
import test from "node:test";

import { ProviderCollectionError } from "./provider-collection.mjs";
import { createDeisletCpuCollector } from "./provider-deislet-cpu.mjs";
import { providerInvocationId } from "./provider-invocation.mjs";

const traceId = "0123456789abcdef0123456789abcdef";

function context(processRunner, responseTraceId = traceId) {
  const operationId = "deislet-cpu-test";
  return {
    request: {
      operationId,
      workDirectory: "/tmp",
      configuration: {
        toolExecutable: "/pinned/deis",
        telemetryUrl: "http://127.0.0.1:41003",
        projectName: "edge-canon-deis-test",
        environmentName: "conformance",
      },
    },
    manifest: {
      backendId: "deislet",
      tool: { sourceRevision: "1ddc7b206b4c4ed62f658d79ddd22cfba3599dbb" },
      security: { timeoutSeconds: 300, maxOutputBytes: 1_048_576 },
    },
    environment: {
      PATH: process.env.PATH ?? "",
      DEIS_TELEMETRY_AUTH_SECRET: "telemetry-secret-canary",
    },
    rawRecord: {
      data: {
        exchange: {
          response: {
            status: 200,
            headers: responseTraceId === null ? {} : { "x-deis-trace-id": responseTraceId },
          },
        },
      },
    },
    deadlineAt: Date.now() + 5_000,
  };
}

function output(invocations) {
  return JSON.stringify({
    app: "edge-canon-deis-test",
    environment: "conformance",
    telemetry_endpoint: "http://127.0.0.1:41003/",
    since: "2026-09-03T00:00:00Z",
    until: null,
    count: invocations.length,
    truncated: false,
    outcomes: {},
    invocations,
  });
}

function record(overrides = {}) {
  return {
    trace_id: traceId,
    time: "2026-09-04T10:00:00Z",
    started_us: 1_788_516_000_000_000,
    duration_us: 15_000,
    app_id: "edge-canon-deis-test",
    environment: "conformance",
    node: "node-one",
    kind: "http",
    outcome: "ok",
    failure: false,
    target: "http://worker.invalid/cpu",
    method: "GET",
    status: 200,
    error: "",
    attributes: { cpu_time_us: "9400" },
    ...overrides,
  };
}

test("Deislet CPU collection polls by response trace id and returns OS-thread CPU", async () => {
  let calls = 0;
  const processRunner = async (options) => {
    calls += 1;
    assert.equal(options.executable, "/pinned/deis");
    assert.deepEqual(options.args, [
      "trace", "--app", "edge-canon-deis-test", "--environment", "conformance",
      "--trace-id", traceId, "--since", "24h", "--limit", "2", "--json",
    ]);
    assert.equal(options.environment.DEIS_TELEMETRY_ENDPOINT, "http://127.0.0.1:41003/");
    assert.equal(options.environment.DEIS_TELEMETRY_AUTH_SECRET, "telemetry-secret-canary");
    assert.deepEqual(options.credentialEnvironment, ["DEIS_TELEMETRY_AUTH_SECRET"]);
    return {
      exitCode: 0,
      signal: null,
      termination: null,
      stdout: output(calls === 1 ? [] : [record()]),
      stderr: "",
      durationMs: 1,
    };
  };
  const result = await createDeisletCpuCollector({ pollIntervalMs: 0, processRunner })(context(processRunner));
  assert.equal(calls, 2);
  assert.equal(result.measuredCpuMilliseconds, 9.4);
  assert.equal(result.measurementKind, "backend-cpu");
  assert.equal(result.resourceFailureCode, null);
  assert.equal(result.invocationId, providerInvocationId("deislet-cpu-test", "EC-WEB-T012", "cpu"));
  assert.doesNotMatch(JSON.stringify(result), /telemetry-secret-canary/);
});

test("Deislet CPU collection refuses a trace that belongs to another deployment", async () => {
  const runner = async () => ({
    exitCode: 0,
    signal: null,
    termination: null,
    stdout: output([record({ app_id: "somebody-else" })]),
    stderr: "",
    durationMs: 1,
  });
  await assert.rejects(
    createDeisletCpuCollector({ pollIntervalMs: 0, processRunner: runner })(context(runner)),
    (error) => error instanceof ProviderCollectionError && error.code === "EC_ADAPTER_CPU_EVIDENCE_INVALID",
  );
});

test("Deislet CPU collection never substitutes duration for a missing CPU field", async () => {
  const runner = async () => ({
    exitCode: 0,
    signal: null,
    termination: null,
    stdout: output([record({ attributes: {} })]),
    stderr: "",
    durationMs: 1,
  });
  await assert.rejects(
    createDeisletCpuCollector({ pollIntervalMs: 0, processRunner: runner })(context(runner)),
    (error) => error instanceof ProviderCollectionError && error.code === "EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE",
  );
});

test("Deislet CPU collection requires a platform-stamped response trace id", async () => {
  let calls = 0;
  await assert.rejects(
    createDeisletCpuCollector({ pollIntervalMs: 0 })(context(async () => {
      calls += 1;
      throw new Error("must not run");
    }, null)),
    (error) => error instanceof ProviderCollectionError && error.code === "EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE",
  );
  assert.equal(calls, 0);
});
