import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AdapterProcessError, runProviderProcess } from "./provider-process.mjs";
import { prepareProviderArtifact, ProviderArtifactError } from "./provider-artifact.mjs";
import {
  cleanupProvider,
  deployProvider,
  operationProjectName,
  ProviderDeploymentError,
  validateDeploymentConfiguration,
} from "./provider-deployment.mjs";

const PROTOCOL_VERSION = "edge-canon.provider-adapter/v1";
const OPERATIONS = new Set(["inspect", "preflight", "prepare", "deploy", "invoke", "collect", "cleanup", "run"]);
const STANDARD_VERSION = /^edge-canon\.next@[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (!condition) throw new AdapterError(code, message);
}

function exactKeys(value, keys, label) {
  fail(value && typeof value === "object" && !Array.isArray(value), "EC_ADAPTER_REQUEST_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  fail(JSON.stringify(actual) === JSON.stringify(expected), "EC_ADAPTER_REQUEST_INVALID", `${label} keys differ`);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new AdapterError("EC_ADAPTER_REQUEST_INVALID", `${label} is not readable JSON: ${error.message}`);
  }
}

function requireAbsolute(value, label) {
  fail(typeof value === "string" && path.isAbsolute(value), "EC_ADAPTER_REQUEST_INVALID", `${label} must be an absolute path`);
}

function validateRequest(request, manifest) {
  exactKeys(
    request,
    [
      "schemaVersion", "protocolVersion", "operation", "operationId", "standardVersion",
      "suiteId", "backendId", "canonicalArtifact", "workDirectory", "evidenceDirectory", "configuration",
    ],
    "request",
  );
  fail(request.schemaVersion === 1, "EC_ADAPTER_REQUEST_INVALID", "request schemaVersion must be 1");
  fail(request.protocolVersion === PROTOCOL_VERSION, "EC_ADAPTER_REQUEST_INVALID", "request protocolVersion differs");
  fail(OPERATIONS.has(request.operation), "EC_ADAPTER_REQUEST_INVALID", "request operation is unknown");
  fail(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.operationId), "EC_ADAPTER_REQUEST_INVALID", "operationId is invalid");
  fail(STANDARD_VERSION.test(request.standardVersion), "EC_ADAPTER_REQUEST_INVALID", "standardVersion must pin an exact commit");
  fail(request.suiteId === manifest.suiteId, "EC_ADAPTER_REQUEST_INVALID", "suiteId differs from adapter");
  fail(request.backendId === manifest.backendId, "EC_ADAPTER_REQUEST_INVALID", "backendId differs from adapter");
  exactKeys(request.canonicalArtifact, ["path", "sha256"], "canonicalArtifact");
  requireAbsolute(request.canonicalArtifact.path, "canonicalArtifact.path");
  fail(SHA256.test(request.canonicalArtifact.sha256), "EC_ADAPTER_REQUEST_INVALID", "canonical artifact digest is invalid");
  requireAbsolute(request.workDirectory, "workDirectory");
  requireAbsolute(request.evidenceDirectory, "evidenceDirectory");
  fail(request.configuration && typeof request.configuration === "object" && !Array.isArray(request.configuration), "EC_ADAPTER_REQUEST_INVALID", "configuration must be an object");
}

function safeEnvironment(hostEnvironment, credentialNames, includeCredentials = false) {
  const environment = {};
  for (const name of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR", "CI", "NO_COLOR"]) {
    if (typeof hostEnvironment[name] === "string") environment[name] = hostEnvironment[name];
  }
  for (const name of credentialNames) {
    const value = hostEnvironment[name];
    fail(typeof value === "string" && value.length > 0, "EC_ADAPTER_CREDENTIAL_MISSING", `required credential environment ${name} is missing`);
    if (includeCredentials) environment[name] = value;
  }
  environment.CI = "1";
  environment.NO_COLOR = "1";
  return environment;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function verifyNpmTool(manifest, configuration) {
  for (const key of ["toolEntrypoint", "toolPackageJson", "toolLockPath"]) {
    requireAbsolute(configuration[key], key);
    fail(fs.statSync(configuration[key], { throwIfNoEntry: false })?.isFile(), "EC_ADAPTER_TOOL_UNPINNED", `${key} is not a regular file`);
  }
  const packageJson = readJson(configuration.toolPackageJson, "toolPackageJson");
  fail(packageJson.name === manifest.tool.package, "EC_ADAPTER_TOOL_UNPINNED", "provider CLI package name differs");
  fail(packageJson.version === manifest.tool.version, "EC_ADAPTER_TOOL_UNPINNED", "provider CLI package version differs");
  const packageRoot = fs.realpathSync(path.dirname(configuration.toolPackageJson));
  const entrypoint = fs.realpathSync(configuration.toolEntrypoint);
  fail(entrypoint.startsWith(`${packageRoot}${path.sep}`), "EC_ADAPTER_TOOL_UNPINNED", "provider CLI entrypoint is outside its package");

  const lock = readJson(configuration.toolLockPath, "toolLockPath");
  const installRoot = path.dirname(fs.realpathSync(configuration.toolLockPath));
  const relativePackageRoot = path.relative(installRoot, packageRoot).split(path.sep).join("/");
  const locked = lock?.packages?.[relativePackageRoot];
  fail(locked?.version === manifest.tool.version, "EC_ADAPTER_TOOL_UNPINNED", "package lock version differs");
  fail(locked?.integrity === manifest.tool.integrity, "EC_ADAPTER_TOOL_UNPINNED", "package lock integrity differs");
  return { executable: process.execPath, baseArgs: [entrypoint] };
}

function verifyWorkspaceTool(manifest, configuration) {
  for (const key of ["toolExecutable", "toolSourceRevision", "toolSha256"]) {
    fail(typeof configuration[key] === "string" && configuration[key].length > 0, "EC_ADAPTER_TOOL_UNPINNED", `${key} is missing`);
  }
  requireAbsolute(configuration.toolExecutable, "toolExecutable");
  fail(fs.statSync(configuration.toolExecutable, { throwIfNoEntry: false })?.isFile(), "EC_ADAPTER_TOOL_UNPINNED", "workspace tool is not a regular file");
  fail(configuration.toolSourceRevision === manifest.tool.sourceRevision, "EC_ADAPTER_TOOL_UNPINNED", "workspace tool source revision differs");
  fail(SHA256.test(configuration.toolSha256), "EC_ADAPTER_TOOL_UNPINNED", "workspace tool digest is invalid");
  fail(sha256File(configuration.toolExecutable) === configuration.toolSha256, "EC_ADAPTER_TOOL_UNPINNED", "workspace tool digest differs");
  return { executable: fs.realpathSync(configuration.toolExecutable), baseArgs: [] };
}

function succeeded(request, manifest, data) {
  return {
    schemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    operation: request.operation,
    operationId: request.operationId,
    backendId: manifest.backendId,
    outcome: "succeeded",
    mutatedRemoteState: false,
    retrySafe: true,
    data,
    evidenceRefs: [],
    failure: null,
  };
}

export async function runAdapter({ manifestPath, request, hostEnvironment = process.env }) {
  const manifest = readJson(manifestPath, "adapter manifest");
  validateRequest(request, manifest);
  const operation = manifest.operations[request.operation];
  fail(operation?.status === "implemented", "EC_ADAPTER_OPERATION_UNIMPLEMENTED", `${request.operation} is not implemented by this draft adapter`);

  if (request.operation === "inspect") {
    return succeeded(request, manifest, {
      adapterStatus: manifest.status,
      entrypoint: manifest.entrypoint,
      protocolVersion: manifest.protocolVersion,
      tool: manifest.tool,
      operationProjectName: operationProjectName(manifest.backendId, request.operationId),
    });
  }

  const requiredConfiguration = manifest.requiredConfiguration[request.operation];
  fail(Array.isArray(requiredConfiguration), "EC_ADAPTER_REQUEST_INVALID", `adapter has no configuration contract for ${request.operation}`);
  for (const key of requiredConfiguration) {
    fail(Object.hasOwn(request.configuration, key), "EC_ADAPTER_CONFIGURATION_MISSING", `required configuration ${key} is missing`);
  }

  if (request.operation === "preflight") validateDeploymentConfiguration(request, manifest);

  if (request.operation === "prepare") {
    return succeeded(request, manifest, prepareProviderArtifact({ request, manifest }));
  }

  fail(fs.statSync(request.workDirectory, { throwIfNoEntry: false })?.isDirectory(), "EC_ADAPTER_REQUEST_INVALID", "workDirectory is not a directory");
  fail(fs.statSync(request.evidenceDirectory, { throwIfNoEntry: false })?.isDirectory(), "EC_ADAPTER_REQUEST_INVALID", "evidenceDirectory is not a directory");
  fail(fs.statSync(request.canonicalArtifact.path, { throwIfNoEntry: false }) !== undefined, "EC_ADAPTER_REQUEST_INVALID", "canonical artifact does not exist");

  const environment = safeEnvironment(
    hostEnvironment,
    manifest.credentialEnvironment[request.operation],
    request.operation !== "preflight",
  );
  const tool = manifest.tool.distribution === "npm"
    ? verifyNpmTool(manifest, request.configuration)
    : verifyWorkspaceTool(manifest, request.configuration);

  if (request.operation === "deploy") {
    return deployProvider({ request, manifest, tool, environment, hostEnvironment });
  }
  if (request.operation === "cleanup") {
    return cleanupProvider({ request, manifest, tool, environment, hostEnvironment });
  }

  const execution = await runProviderProcess({
    executable: tool.executable,
    args: [...tool.baseArgs, "--version"],
    cwd: request.workDirectory,
    environment,
    credentialEnvironment: [],
    timeoutMs: manifest.security.timeoutSeconds * 1_000,
    maxOutputBytes: manifest.security.maxOutputBytes,
  });
  fail(execution.termination !== "timeout", "EC_ADAPTER_TOOL_TIMEOUT", "provider CLI version probe timed out");
  fail(execution.termination !== "output-limit", "EC_ADAPTER_TOOL_OUTPUT_LIMIT", "provider CLI version probe exceeded its output limit");
  fail(execution.exitCode === 0, "EC_ADAPTER_TOOL_VERSION_FAILED", "provider CLI version probe failed");
  const versionText = `${execution.stdout}\n${execution.stderr}`;
  fail(
    new RegExp(`(^|[^0-9])${manifest.tool.version.replaceAll(".", "\\.")}([^0-9]|$)`).test(versionText),
    "EC_ADAPTER_TOOL_VERSION_MISMATCH",
    "provider CLI did not report the pinned version",
  );
  return succeeded(request, manifest, {
    credentialEnvironment: manifest.credentialEnvironment[request.operation],
    toolDistribution: manifest.tool.distribution,
    toolName: manifest.tool.package ?? manifest.tool.binary,
    toolVersion: manifest.tool.version,
    versionProbeDurationMs: execution.durationMs,
  });
}

function failureResult(request, manifest, error) {
  const code = error instanceof AdapterError || error instanceof AdapterProcessError || error instanceof ProviderArtifactError || error instanceof ProviderDeploymentError
    ? error.code
    : "EC_ADAPTER_INTERNAL";
  return {
    schemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    operation: OPERATIONS.has(request?.operation) ? request.operation : "inspect",
    operationId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request?.operationId ?? "") ? request.operationId : "invalid-request",
    backendId: manifest.backendId,
    outcome: "failed",
    mutatedRemoteState: false,
    retrySafe: true,
    data: {},
    evidenceRefs: [],
    failure: { code, message: error instanceof Error ? error.message : String(error) },
  };
}

export async function adapterMain(manifestUrl, argv = process.argv.slice(2)) {
  const manifestPath = fileURLToPath(manifestUrl);
  const manifest = readJson(manifestPath, "adapter manifest");
  let request;
  try {
    fail(argv.length === 2 && argv[0] === "--request", "EC_ADAPTER_REQUEST_INVALID", "usage: adapter.mjs --request <absolute-path>");
    requireAbsolute(argv[1], "request path");
    request = readJson(argv[1], "request");
    const result = await runAdapter({ manifestPath, request });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failureResult(request, manifest, error))}\n`);
    return 1;
  }
}
