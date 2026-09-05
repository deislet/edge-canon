import crypto from "node:crypto";

export const SECRET_A = "EC_ENV_SECRET_A_7f9d41b18e";
export const SECRET_B = "EC_ENV_SECRET_B_b316ac5702";
export const PROVIDER_CANARY = "PROVIDER_INTERNAL_CANARY";
export const HOST_CANARY = "HOST_INTERNAL_CANARY";

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(stableValue(value)), "utf8");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(value)).digest("hex");
}

export function documentIdentity(value) {
  return sha256(canonicalBytes(value));
}

export function configRevision(value, valueType) {
  const bytes = valueType === "string" ? Buffer.from(value, "utf8") : canonicalBytes(value);
  return sha256(bytes);
}

export function declarationDocument(standardVersion, declarations) {
  return {
    $schema: "https://github.com/deislet/edge-canon/schemas/environment-secrets.schema.json",
    schemaVersion: 1,
    format: "edge-canon.environment-secrets/v1",
    standardVersion,
    access: { surface: "context.env", extraProviderBindings: "excluded" },
    limits: { bindingCount: 64, valueBytes: 5120, measurement: "utf-8" },
    declarations: declarations ?? [
      { name: "APP_MODE", kind: "config", valueType: "string", required: true },
      { name: "SETTINGS", kind: "config", valueType: "json", required: true },
      { name: "API_TOKEN", kind: "secret", valueType: "string", required: true },
      { name: "OPTIONAL_LABEL", kind: "config", valueType: "string", required: false },
    ],
  };
}

export function bindingSnapshot(document, options = {}) {
  const marker = options.marker ?? "old";
  const settings = { marker, nested: { enabled: true }, list: [1, 2, 3] };
  return {
    $schema: "https://github.com/deislet/edge-canon/schemas/environment-binding-snapshot.schema.json",
    schemaVersion: 1,
    format: "edge-canon.environment-binding-snapshot/v1",
    standardVersion: document.standardVersion,
    deploymentVersionId: options.deploymentVersionId ?? `deployment-${marker}`,
    environmentId: options.environmentId ?? "production",
    declarationsSha256: documentIdentity(document),
    activation: {
      mode: "version-bound-atomic",
      missingRequired: "reject",
      unavailableSecretRevision: "reject",
    },
    bindings: options.bindings ?? [
      { name: "APP_MODE", kind: "config", valueType: "string", revision: configRevision(marker, "string"), value: marker },
      { name: "SETTINGS", kind: "config", valueType: "json", revision: configRevision(settings, "json"), value: settings },
      { name: "API_TOKEN", kind: "secret", valueType: "string", revision: `secret-token-${marker}` },
    ],
  };
}

export function secretStore() {
  return new Map([
    ["secret-token-old", SECRET_A],
    ["secret-token-new", SECRET_B],
  ]);
}
