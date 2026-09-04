const EXACT_STANDARD = /^edge-canon\.next@[0-9a-f]{40}$/;

export class WebApiContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WebApiContractError";
    this.code = code;
  }
}

function reject(code, message) {
  throw new WebApiContractError(code, message);
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(code, "invalid object");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) reject(code, "unknown or missing field");
}

export function validateCapabilityLock(value, expectedStandardVersion) {
  exactKeys(value, ["schemaVersion", "format", "standardVersion", "baselineDate", "apis", "limits", "providerExtensions"], "EC_WEBAPI_DOCUMENT_INVALID");
  if (value.schemaVersion !== 1 || value.format !== "edge-canon.web-platform-apis/v1") reject("EC_WEBAPI_VERSION_UNSUPPORTED", "unsupported capability lock format");
  if (!EXACT_STANDARD.test(value.standardVersion)) reject("EC_WEBAPI_STANDARD_PIN_INVALID", "exact standard commit required");
  if (value.standardVersion !== expectedStandardVersion) reject("EC_WEBAPI_STANDARD_MISMATCH", "standard commit mismatch");
  if (value.baselineDate !== "2026-09-04") reject("EC_WEBAPI_BASELINE_UNSUPPORTED", "unsupported upstream baseline");
  exactKeys(value.apis, ["url", "headers", "request", "response", "encoding", "base64", "abort", "crypto", "fetch", "timers"], "EC_WEBAPI_DOCUMENT_INVALID");
  const expectedApis = {
    url: "whatwg-selected-subset", headers: "fetch-sort-and-combine",
    request: "fetch-selected-subset", response: "fetch-selected-subset",
    encoding: "utf-8", base64: "html-binary-string",
    abort: "controller-signal-event", crypto: "random-uuid-sha256",
    fetch: "http-https-fetch-redirect", timers: "timeout-interval-basic",
  };
  for (const [key, expected] of Object.entries(expectedApis)) {
    if (value.apis[key] !== expected) reject("EC_WEBAPI_API_SET_INVALID", "unsupported required API set");
  }
  exactKeys(value.limits, ["bodyReaderOctets", "headerNameAsciiCharacters", "headerValueAsciiCharacters", "randomValuesOctets"], "EC_WEBAPI_DOCUMENT_INVALID");
  const expectedLimits = {
    bodyReaderOctets: 1_000_000,
    headerNameAsciiCharacters: 128,
    headerValueAsciiCharacters: 4_095,
    randomValuesOctets: 65_536,
  };
  for (const [key, expected] of Object.entries(expectedLimits)) {
    if (value.limits[key] !== expected) reject("EC_WEBAPI_LIMIT_SET_INVALID", "unsupported resource boundary");
  }
  if (value.providerExtensions !== "non-portable") reject("EC_WEBAPI_EXTENSION_POLICY_INVALID", "provider extension policy differs");
  return value;
}

export function deriveProviderConfiguration(lock, providerId) {
  validateCapabilityLock(lock, lock.standardVersion);
  if (providerId === "cloudflare-workers-pages") {
    return {
      providerId, urlParser: "standard", responseRedirectUrlParser: "standard",
      compatibilityDateFloor: "2023-03-14", redirectCredentials: "edge-canon-shim",
    };
  }
  if (providerId === "tencent-edgeone-makers") {
    return { providerId, urlParser: "standard", requestCloneHeaders: "edge-canon-shim", redirectCredentials: "edge-canon-shim" };
  }
  if (providerId === "deislet") {
    return { providerId, urlParser: "standard", redirectCredentials: "native-or-shim" };
  }
  reject("EC_WEBAPI_PROVIDER_UNKNOWN", "unknown provider");
}

export function captureContractFailure(value, expectedStandardVersion) {
  try {
    validateCapabilityLock(value, expectedStandardVersion);
    return null;
  } catch (error) {
    if (!(error instanceof WebApiContractError)) throw error;
    return error.code;
  }
}
