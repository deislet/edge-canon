import { sha256 } from "./canonical-artifact.mjs";
import { ProviderCollectionError } from "./provider-collection.mjs";
import { providerInvocationId } from "./provider-invocation.mjs";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const CF_RAY = /^[A-Za-z0-9]{8,64}(?:-[A-Za-z0-9]{3,16})?$/;

function fail(condition, code, message) {
  if (!condition) throw new ProviderCollectionError(code, message);
}

async function readBounded(response, controller, deadlineAt) {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  fail(!Number.isFinite(declared) || declared <= MAX_RESPONSE_BYTES, "EC_ADAPTER_REMOTE_OUTPUT_LIMIT", "Cloudflare telemetry response is oversized");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const remaining = deadlineAt - Date.now();
      fail(remaining > 0, "EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE", "Cloudflare telemetry query timed out");
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProviderCollectionError("EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE", "Cloudflare telemetry response timed out"));
        }, remaining);
      });
      const result = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProviderCollectionError("EC_ADAPTER_REMOTE_OUTPUT_LIMIT", "Cloudflare telemetry response is oversized");
      }
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

async function queryCloudflare(url, token, body, fetchImpl, deadlineAt) {
  const controller = new AbortController();
  const remaining = deadlineAt - Date.now();
  fail(remaining > 0, "EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE", "Cloudflare telemetry did not become available before the collection deadline");
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
    fail(response.ok, "EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE", `Cloudflare telemetry returned HTTP ${response.status}`);
    const bytes = await readBounded(response, controller, deadlineAt);
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new ProviderCollectionError("EC_ADAPTER_CPU_EVIDENCE_INVALID", `Cloudflare telemetry returned invalid JSON: ${error.message}`);
    }
  } catch (error) {
    if (error instanceof ProviderCollectionError) throw error;
    throw new ProviderCollectionError("EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE", "Cloudflare telemetry request failed");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function cpuEvents(document, rayId, projectName, versionId) {
  fail(document?.success === true && Array.isArray(document.errors) && document.errors.length === 0, "EC_ADAPTER_CPU_EVIDENCE_INVALID", "Cloudflare telemetry API reported an error");
  const events = document.result?.events?.events;
  fail(Array.isArray(events), "EC_ADAPTER_CPU_EVIDENCE_INVALID", "Cloudflare telemetry response has no event list");
  const matching = [];
  for (const [index, event] of events.entries()) {
    fail(event && typeof event === "object" && !Array.isArray(event), "EC_ADAPTER_CPU_EVIDENCE_INVALID", `Cloudflare telemetry event ${index} is invalid`);
    const metadata = event.$metadata;
    const workers = event.$workers;
    fail(metadata && typeof metadata === "object" && workers && typeof workers === "object", "EC_ADAPTER_CPU_EVIDENCE_INVALID", `Cloudflare telemetry event ${index} lacks invocation metadata`);
    fail(metadata.rayId === rayId, "EC_ADAPTER_CPU_EVIDENCE_INVALID", `Cloudflare telemetry event ${index} Ray ID differs`);
    fail(metadata.service === projectName || workers.scriptName === projectName, "EC_ADAPTER_CPU_EVIDENCE_INVALID", `Cloudflare telemetry event ${index} script identity differs`);
    if (workers.scriptVersion?.id !== undefined) {
      fail(workers.scriptVersion.id === versionId, "EC_ADAPTER_CPU_EVIDENCE_INVALID", `Cloudflare telemetry event ${index} deployment version differs`);
    }
    if (Number.isFinite(workers.cpuTimeMs)) matching.push(event);
  }
  fail(matching.length <= 1, "EC_ADAPTER_CPU_EVIDENCE_INVALID", "Cloudflare telemetry returned multiple CPU-bearing events for T012");
  return matching;
}

function redactDocument(document, secrets) {
  let text = JSON.stringify(document);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) text = text.replaceAll(secret, "[REDACTED]");
  }
  return JSON.parse(text);
}

export function createCloudflareCpuCollector({ pollIntervalMs = 1_000, timeoutMs = null } = {}) {
  fail(Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 0, "EC_ADAPTER_INTERNAL", "Cloudflare CPU poll interval is invalid");
  return async function cloudflareCpuCollector({ request, manifest, environment, invocation, rawRecord, fetchImpl, deadlineAt }) {
    fail(manifest.backendId === "cloudflare-workers-pages", "EC_ADAPTER_INTERNAL", "Cloudflare CPU collector received another backend");
    const headers = rawRecord?.data?.exchange?.response?.headers;
    const rayId = headers?.["cf-ray"];
    fail(typeof rayId === "string" && CF_RAY.test(rayId), "EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE", "T012 response has no valid Cloudflare Ray ID");
    const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = environment.CLOUDFLARE_API_TOKEN;
    fail(typeof accountId === "string" && accountId.length > 0 && typeof apiToken === "string" && apiToken.length > 0, "EC_ADAPTER_CREDENTIAL_MISSING", "Cloudflare telemetry credentials are missing");
    const observedAt = Date.parse(rawRecord.observedAt);
    fail(Number.isFinite(observedAt), "EC_ADAPTER_EVIDENCE_INVALID", "T012 observation timestamp is invalid");
    const projectName = request.configuration.projectName;
    const versionId = invocation.deployment.provider.versionId;
    fail(typeof versionId === "string" && versionId.length > 0, "EC_ADAPTER_STATE_INVALID", "Cloudflare deployment has no version identity");
    const query = {
      queryId: `edge-canon-cpu-${sha256(Buffer.from(`${request.operationId}\0${rayId}`, "utf8")).slice(0, 24)}`,
      view: "events",
      limit: 100,
      dry: false,
      parameters: {
        datasets: ["cloudflare-workers"],
        filterCombination: "and",
        filters: [
          { key: "$metadata.rayId", operation: "eq", type: "string", value: rayId },
          { key: "$metadata.service", operation: "eq", type: "string", value: projectName },
        ],
        calculations: [],
        groupBys: [],
        havings: [],
      },
      timeframe: {
        from: Math.max(0, observedAt - 5 * 60_000),
        to: observedAt + 5 * 60_000,
      },
    };
    const effectiveDeadline = Math.min(
      Number.isFinite(deadlineAt) ? deadlineAt : Number.POSITIVE_INFINITY,
      Date.now() + (timeoutMs ?? manifest.security.timeoutSeconds * 1_000),
    );
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/observability/telemetry/query`;
    while (true) {
      const document = await queryCloudflare(url, apiToken, query, fetchImpl, effectiveDeadline);
      const matches = cpuEvents(document, rayId, projectName, versionId);
      if (matches.length === 1) {
        const event = matches[0];
        const outcome = event.$workers.outcome;
        return {
          schemaVersion: 1,
          backendId: manifest.backendId,
          invocationId: providerInvocationId(request.operationId, "EC-WEB-T012", "cpu"),
          measurementKind: "backend-cpu",
          measuredCpuMilliseconds: event.$workers.cpuTimeMs,
          resourceFailureCode: outcome === "ok" ? null
            : outcome === "exceededCpu" ? "EC_CPU_LIMIT_EXCEEDED"
              : "EC_PROVIDER_INVOCATION_FAILED",
          providerEvidence: {
            source: "cloudflare-workers-observability-telemetry",
            query,
            response: redactDocument(document, [apiToken]),
          },
        };
      }
      fail(Date.now() < effectiveDeadline, "EC_ADAPTER_CPU_EVIDENCE_UNAVAILABLE", "Cloudflare telemetry did not expose T012 CPU time before the collection deadline");
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, effectiveDeadline - Date.now()))));
    }
  };
}

export const cloudflareCpuCollector = createCloudflareCpuCollector();
