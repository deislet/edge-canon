import { runProviderProcess } from "./provider-process.mjs";
import { providerInvocationId } from "./provider-invocation.mjs";
import { ProviderCollectionError } from "./provider-collection.mjs";

const TRACE_ID = /^[0-9a-f]{32}$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;

function fail(condition, code, message) {
  if (!condition) throw new ProviderCollectionError(code, message);
}

function telemetryEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ProviderCollectionError("EC_ADAPTER_CONFIGURATION_INVALID", `telemetryUrl is invalid: ${error.message}`);
  }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  fail(url.protocol === "https:" || loopback, "EC_ADAPTER_CONFIGURATION_INVALID", "telemetryUrl must use HTTPS or HTTP loopback");
  fail(!url.username && !url.password && !url.search && !url.hash, "EC_ADAPTER_CONFIGURATION_INVALID", "telemetryUrl contains credentials, a query, or a fragment");
  return url.href;
}

function parseDocument(text) {
  try {
    const value = JSON.parse(text);
    fail(value && typeof value === "object" && !Array.isArray(value), "EC_ADAPTER_CPU_EVIDENCE_INVALID", "deis trace output is not a JSON object");
    return value;
  } catch (error) {
    if (error instanceof ProviderCollectionError) throw error;
    throw new ProviderCollectionError("EC_ADAPTER_CPU_EVIDENCE_INVALID", `deis trace returned invalid JSON: ${error.message}`);
  }
}

function cpuRecord(document, { traceId, projectName, environmentName, responseStatus }) {
  fail(Number.isSafeInteger(document.count) && Array.isArray(document.invocations), "EC_ADAPTER_CPU_EVIDENCE_INVALID", "deis trace output has no bounded invocation list");
  fail(document.count === document.invocations.length, "EC_ADAPTER_CPU_EVIDENCE_INVALID", "deis trace count differs from its invocation list");
  fail(document.invocations.length <= 1, "EC_ADAPTER_CPU_EVIDENCE_INVALID", "deis trace returned multiple records for one trace id");
  if (document.invocations.length === 0) return null;
  const record = document.invocations[0];
  fail(record && typeof record === "object" && !Array.isArray(record), "EC_ADAPTER_CPU_EVIDENCE_INVALID", "deis trace invocation is invalid");
  fail(record.trace_id === traceId, "EC_ADAPTER_CPU_EVIDENCE_INVALID", "deis trace identity differs from the response trace id");
  fail(record.app_id === projectName && record.environment === environmentName, "EC_ADAPTER_CPU_EVIDENCE_INVALID", "deis trace application identity differs from the deployment");
  fail(record.kind === "http", "EC_ADAPTER_CPU_EVIDENCE_INVALID", "deis trace record is not an HTTP invocation");
  fail(record.status === responseStatus, "EC_ADAPTER_CPU_EVIDENCE_INVALID", "deis trace status differs from the observed response");
  fail(record.attributes && typeof record.attributes === "object" && !Array.isArray(record.attributes), "EC_ADAPTER_CPU_EVIDENCE_INVALID", "deis trace attributes are invalid");
  const microseconds = record.attributes.cpu_time_us;
  fail(typeof microseconds === "string" && INTEGER.test(microseconds), "EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE", "deis trace has no OS-thread cpu_time_us measurement");
  const measured = Number(microseconds);
  fail(Number.isSafeInteger(measured), "EC_ADAPTER_CPU_EVIDENCE_INVALID", "deis trace CPU measurement is outside the exact integer range");
  return { record, measuredCpuMilliseconds: measured / 1_000 };
}

/** Collect one Deislet invocation's backend CPU through the pinned native CLI. */
export function createDeisletCpuCollector({
  pollIntervalMs = 100,
  processRunner = runProviderProcess,
} = {}) {
  fail(Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 0, "EC_ADAPTER_INTERNAL", "Deislet CPU poll interval is invalid");
  return async function deisletCpuCollector({ request, manifest, environment, rawRecord, deadlineAt }) {
    fail(manifest.backendId === "deislet", "EC_ADAPTER_INTERNAL", "Deislet CPU collector received another backend");
    const headers = rawRecord?.data?.exchange?.response?.headers;
    const traceId = headers?.["x-deis-trace-id"];
    fail(typeof traceId === "string" && TRACE_ID.test(traceId), "EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE", "T012 response has no valid Deislet trace id");
    const responseStatus = rawRecord?.data?.exchange?.response?.status;
    fail(Number.isSafeInteger(responseStatus), "EC_ADAPTER_EVIDENCE_INVALID", "T012 response has no HTTP status");
    const secret = environment.DEIS_TELEMETRY_AUTH_SECRET;
    fail(typeof secret === "string" && secret.length > 0, "EC_ADAPTER_CREDENTIAL_MISSING", "Deislet telemetry credential is missing");
    const endpoint = telemetryEndpoint(request.configuration.telemetryUrl);
    const executable = request.configuration.toolExecutable;
    fail(typeof executable === "string", "EC_ADAPTER_TOOL_UNPINNED", "Deislet tool executable is missing");
    const processEnvironment = {
      ...environment,
      DEIS_TELEMETRY_ENDPOINT: endpoint,
    };
    const effectiveDeadline = Math.min(
      Number.isFinite(deadlineAt) ? deadlineAt : Number.POSITIVE_INFINITY,
      Date.now() + manifest.security.timeoutSeconds * 1_000,
    );
    const args = [
      "trace",
      "--app", request.configuration.projectName,
      "--environment", request.configuration.environmentName,
      "--trace-id", traceId,
      "--since", "24h",
      "--limit", "2",
      "--json",
    ];
    while (true) {
      const remaining = effectiveDeadline - Date.now();
      fail(remaining > 0, "EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE", "Deislet invocation trace did not become available before the collection deadline");
      const execution = await processRunner({
        executable,
        args,
        cwd: request.workDirectory,
        environment: processEnvironment,
        credentialEnvironment: ["DEIS_TELEMETRY_AUTH_SECRET"],
        timeoutMs: Math.max(1, Math.min(30_000, remaining)),
        maxOutputBytes: manifest.security.maxOutputBytes,
      });
      fail(execution.termination !== "timeout", "EC_ADAPTER_TOOL_TIMEOUT", "deis trace timed out");
      fail(execution.termination !== "output-limit", "EC_ADAPTER_TOOL_OUTPUT_LIMIT", "deis trace exceeded its output limit");
      fail(execution.exitCode === 0, "EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE", "deis trace could not query invocation telemetry");
      const document = parseDocument(execution.stdout);
      const found = cpuRecord(document, {
        traceId,
        projectName: request.configuration.projectName,
        environmentName: request.configuration.environmentName,
        responseStatus,
      });
      if (found) {
        const outcome = found.record.outcome;
        return {
          schemaVersion: 1,
          backendId: manifest.backendId,
          invocationId: providerInvocationId(request.operationId, "EC-WEB-T012", "cpu"),
          measurementKind: "backend-cpu",
          measuredCpuMilliseconds: found.measuredCpuMilliseconds,
          resourceFailureCode: outcome === "ok" ? null
            : outcome === "cpu-limit" ? "EC_CPU_LIMIT_EXCEEDED"
              : "EC_PROVIDER_INVOCATION_FAILED",
          providerEvidence: {
            source: "deis-telemetry-trace-service",
            traceId,
            query: {
              executableRevision: manifest.tool.sourceRevision,
              telemetryEndpoint: endpoint,
              app: request.configuration.projectName,
              environment: request.configuration.environmentName,
            },
            response: document,
          },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, effectiveDeadline - Date.now()))));
    }
  };
}

export const deisletCpuCollector = createDeisletCpuCollector();
