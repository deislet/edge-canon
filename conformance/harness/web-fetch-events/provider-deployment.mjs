import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sha256 } from "./canonical-artifact.mjs";
import { redactText, runProviderProcess } from "./provider-process.mjs";
import { validatePreparedProviderArtifact } from "./provider-artifact.mjs";

const STATE_FORMAT = "edge-canon.provider-deployment-state/v1";
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HTTPS_OR_LOOPBACK = /^(?:https:\/\/|http:\/\/(?:127(?:\.[0-9]{1,3}){3}|\[::1\]|localhost)(?::[0-9]+)?(?:\/|$))/;
const EDGEONE_API = {
  global: { endpoint: "https://pages-api.edgeone.ai/v1", region: "ap-singapore" },
  china: { endpoint: "https://pages-api.cloud.tencent.com/v1", region: "ap-guangzhou" },
};

export class ProviderDeploymentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderDeploymentError";
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (!condition) throw new ProviderDeploymentError(code, message);
}

function exactKeys(value, keys, label) {
  fail(value && typeof value === "object" && !Array.isArray(value), "EC_ADAPTER_STATE_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  fail(JSON.stringify(actual) === JSON.stringify(expected), "EC_ADAPTER_STATE_INVALID", `${label} keys differ`);
}

function plainDirectory(directory, label) {
  const status = fs.lstatSync(directory, { throwIfNoEntry: false });
  fail(status?.isDirectory() && !status.isSymbolicLink(), "EC_ADAPTER_REQUEST_INVALID", `${label} is not a regular directory`);
  const resolved = path.resolve(directory);
  fail(fs.realpathSync(directory) === resolved, "EC_ADAPTER_REQUEST_INVALID", `${label} traverses a symbolic link`);
  return resolved;
}

function strictDescendant(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function syncDirectory(directory) {
  try {
    const descriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (!["EINVAL", "EISDIR", "EPERM", "ENOTSUP"].includes(error?.code)) throw error;
  }
}

function ensurePrivateDirectory(directory, label) {
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing) {
    fail(existing.isDirectory() && !existing.isSymbolicLink(), "EC_ADAPTER_STATE_INVALID", `${label} is not a regular directory`);
  } else {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}

function writeJsonAtomic(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  fail(!existing || (existing.isFile() && !existing.isSymbolicLink()), "EC_ADAPTER_STATE_INVALID", "deployment state path is not a regular file");
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
    syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    }
    throw error;
  }
}

function stateDirectory(request, manifest) {
  const work = plainDirectory(request.workDirectory, "workDirectory");
  const root = path.join(work, ".edge-canon-provider-state");
  fail(strictDescendant(work, ensurePrivateDirectory(root, "deployment state directory")), "EC_ADAPTER_STATE_INVALID", "deployment state directory escapes workDirectory");
  const backend = path.join(root, manifest.backendId);
  fail(strictDescendant(root, ensurePrivateDirectory(backend, "backend state directory")), "EC_ADAPTER_STATE_INVALID", "backend state directory escapes its root");
  return backend;
}

function copyRegularTree(source, destination) {
  fs.mkdirSync(destination, { mode: 0o700 });
  fs.chmodSync(destination, 0o700);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const status = fs.lstatSync(from);
    fail(!status.isSymbolicLink(), "EC_ADAPTER_ARTIFACT_INVALID", "derived deployment input contains a symbolic link");
    if (status.isDirectory()) copyRegularTree(from, to);
    else {
      fail(status.isFile(), "EC_ADAPTER_ARTIFACT_INVALID", "derived deployment input contains a non-file");
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, 0o600);
    }
  }
}

function regularTree(root, label) {
  const rootStatus = fs.lstatSync(root, { throwIfNoEntry: false });
  fail(rootStatus?.isDirectory() && !rootStatus.isSymbolicLink(), "EC_ADAPTER_STATE_INVALID", `${label} is not a regular directory`);
  fail(fs.realpathSync(root) === path.resolve(root), "EC_ADAPTER_STATE_INVALID", `${label} traverses a symbolic link`);
  const entries = [];
  function visit(directory, prefix) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const status = fs.lstatSync(absolute);
      fail(!status.isSymbolicLink(), "EC_ADAPTER_STATE_INVALID", `${label} contains a symbolic link`);
      if (status.isDirectory()) {
        entries.push([relative, "directory", null]);
        visit(absolute, relative);
      } else {
        fail(status.isFile(), "EC_ADAPTER_STATE_INVALID", `${label} contains a non-file`);
        entries.push([relative, "file", sha256(fs.readFileSync(absolute))]);
      }
    }
  }
  visit(root, "");
  return entries;
}

function deploymentInputMatches(source, target) {
  return JSON.stringify(regularTree(source, "derived deployment input"))
    === JSON.stringify(regularTree(target, "recovered deployment input"));
}

function deploymentInputDirectory(request, manifest) {
  const work = plainDirectory(request.workDirectory, "workDirectory");
  const root = path.join(work, ".edge-canon-provider-input");
  fail(strictDescendant(work, ensurePrivateDirectory(root, "deployment input root")), "EC_ADAPTER_STATE_INVALID", "deployment input root escapes workDirectory");
  const key = sha256(Buffer.from(`${manifest.backendId}\0${request.operationId}`, "utf8"));
  return path.join(root, `${manifest.backendId}-${key}`);
}

function createDeploymentInput(request, manifest) {
  const target = deploymentInputDirectory(request, manifest);
  if (fs.existsSync(target)) {
    fail(
      deploymentInputMatches(request.configuration.derivedDirectory, target),
      "EC_ADAPTER_STATE_INVALID",
      "recovered deployment input differs from the validated derived artifact",
    );
    return target;
  }
  const staged = `${target}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  try {
    copyRegularTree(request.configuration.derivedDirectory, staged);
    fs.renameSync(staged, target);
    syncDirectory(path.dirname(target));
    return target;
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function readOperationLock(lockPath) {
  const status = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  fail(status?.isFile() && !status.isSymbolicLink(), "EC_ADAPTER_STATE_INVALID", "operation lock is not a regular file");
  fail(status.size <= 4096, "EC_ADAPTER_STATE_INVALID", "operation lock is oversized");
  let value;
  try {
    value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (error) {
    throw new ProviderDeploymentError("EC_ADAPTER_STATE_INVALID", `operation lock is not readable JSON: ${error.message}`);
  }
  exactKeys(value, ["schemaVersion", "hostname", "pid", "nonce", "createdAt"], "operation lock");
  fail(value.schemaVersion === 1, "EC_ADAPTER_STATE_INVALID", "operation lock schemaVersion differs");
  fail(typeof value.hostname === "string" && value.hostname, "EC_ADAPTER_STATE_INVALID", "operation lock hostname is invalid");
  fail(Number.isSafeInteger(value.pid) && value.pid > 0, "EC_ADAPTER_STATE_INVALID", "operation lock pid is invalid");
  fail(/^[0-9a-f]{32}$/.test(value.nonce), "EC_ADAPTER_STATE_INVALID", "operation lock nonce is invalid");
  fail(Number.isFinite(Date.parse(value.createdAt)), "EC_ADAPTER_STATE_INVALID", "operation lock timestamp is invalid");
  return { value, inode: status.ino };
}

export function acquireOperationLock(statePath) {
  const lockPath = `${statePath}.lock`;
  const hostname = os.hostname();
  const nonce = crypto.randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    let ownsPath = false;
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      ownsPath = true;
      const value = { schemaVersion: 1, hostname, pid: process.pid, nonce, createdAt: now() };
      fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.chmodSync(lockPath, 0o600);
      syncDirectory(path.dirname(lockPath));
      return () => {
        const current = readOperationLock(lockPath);
        fail(current.value.nonce === nonce, "EC_ADAPTER_STATE_INVALID", "operation lock ownership changed");
        fs.unlinkSync(lockPath);
        syncDirectory(path.dirname(lockPath));
      };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (ownsPath) {
        try {
          fs.unlinkSync(lockPath);
          syncDirectory(path.dirname(lockPath));
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        }
      }
      if (error?.code !== "EEXIST") throw error;
      const current = readOperationLock(lockPath);
      if (current.value.hostname === hostname && !processIsAlive(current.value.pid)) {
        const latest = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        fail(latest?.ino === current.inode, "EC_ADAPTER_OPERATION_BUSY", "operation lock changed while checking its owner");
        fs.unlinkSync(lockPath);
        syncDirectory(path.dirname(lockPath));
        continue;
      }
      throw new ProviderDeploymentError("EC_ADAPTER_OPERATION_BUSY", "another live or externally owned process holds this operation identity");
    }
  }
  throw new ProviderDeploymentError("EC_ADAPTER_OPERATION_BUSY", "operation lock could not be acquired");
}

export function loadProviderDeployment({ request, manifest }) {
  const artifact = validatePreparedProviderArtifact({ request, manifest });
  const filePath = deploymentStatePath(request, manifest);
  const state = readState(filePath, request, manifest, artifact);
  fail(state, "EC_ADAPTER_STATE_MISSING", "operation has no deployment state");
  return { artifact, filePath, state };
}

function removeTemporaryOutput(outputPath) {
  if (!outputPath) return;
  try {
    fs.unlinkSync(outputPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function deploymentStatePath(request, manifest) {
  const key = sha256(Buffer.from(`${manifest.backendId}\0${request.operationId}`, "utf8"));
  return path.join(stateDirectory(request, manifest), `${key}.json`);
}

function validateProvider(provider) {
  exactKeys(provider, ["projectId", "deploymentId", "versionId", "url", "environment"], "deployment state provider");
  for (const key of ["projectId", "deploymentId", "versionId", "url", "environment"]) {
    fail(provider[key] === null || typeof provider[key] === "string", "EC_ADAPTER_STATE_INVALID", `provider.${key} is invalid`);
  }
}

function validateState(state, request, manifest, artifact) {
  exactKeys(
    state,
    [
      "schemaVersion", "stateFormat", "operationId", "backendId", "standardVersion", "suiteId",
      "canonicalArtifactSha256", "derivedArtifactSha256", "projectName", "status", "provider",
      "createdAt", "updatedAt",
    ],
    "deployment state",
  );
  fail(state.schemaVersion === 1 && state.stateFormat === STATE_FORMAT, "EC_ADAPTER_STATE_INVALID", "deployment state format differs");
  fail(state.operationId === request.operationId, "EC_ADAPTER_STATE_INVALID", "deployment state operation differs");
  fail(state.backendId === manifest.backendId, "EC_ADAPTER_STATE_INVALID", "deployment state backend differs");
  fail(state.standardVersion === request.standardVersion && state.suiteId === request.suiteId, "EC_ADAPTER_STATE_INVALID", "deployment state standard differs");
  fail(state.canonicalArtifactSha256 === artifact.canonicalArtifactSha256, "EC_ADAPTER_STATE_INVALID", "deployment state canonical digest differs");
  fail(state.derivedArtifactSha256 === artifact.derivedArtifactSha256, "EC_ADAPTER_STATE_INVALID", "deployment state derived digest differs");
  fail(state.projectName === request.configuration.projectName, "EC_ADAPTER_STATE_INVALID", "deployment state project differs");
  fail(["deploying", "deployed", "deploy-indeterminate", "cleaning", "cleanup-indeterminate", "cleaned"].includes(state.status), "EC_ADAPTER_STATE_INVALID", "deployment state status is unknown");
  fail(Number.isFinite(Date.parse(state.createdAt)) && Number.isFinite(Date.parse(state.updatedAt)), "EC_ADAPTER_STATE_INVALID", "deployment state timestamp is invalid");
  validateProvider(state.provider);
  return state;
}

function readState(filePath, request, manifest, artifact) {
  const status = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!status) return null;
  fail(status.isFile() && !status.isSymbolicLink(), "EC_ADAPTER_STATE_INVALID", "deployment state is not a regular file");
  fail(fs.realpathSync(filePath) === path.resolve(filePath), "EC_ADAPTER_STATE_INVALID", "deployment state traverses a symbolic link");
  let state;
  try {
    state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new ProviderDeploymentError("EC_ADAPTER_STATE_INVALID", `deployment state is not readable JSON: ${error.message}`);
  }
  return validateState(state, request, manifest, artifact);
}

function now() {
  return new Date().toISOString();
}

function emptyProvider(environment = null) {
  return { projectId: null, deploymentId: null, versionId: null, url: null, environment };
}

function initialState(request, manifest, artifact) {
  const timestamp = now();
  return {
    schemaVersion: 1,
    stateFormat: STATE_FORMAT,
    operationId: request.operationId,
    backendId: manifest.backendId,
    standardVersion: request.standardVersion,
    suiteId: request.suiteId,
    canonicalArtifactSha256: artifact.canonicalArtifactSha256,
    derivedArtifactSha256: artifact.derivedArtifactSha256,
    projectName: request.configuration.projectName,
    status: "deploying",
    provider: emptyProvider(request.configuration.deploymentEnvironment ?? request.configuration.environmentName ?? null),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function transition(filePath, state, status, provider = state.provider) {
  const next = { ...state, status, provider, updatedAt: now() };
  writeJsonAtomic(filePath, next);
  return next;
}

function evidenceRef(filePath, bytes) {
  return `evidence:${path.basename(filePath)}:sha256:${sha256(bytes)}`;
}

function writeEvidence(request, name, value) {
  const evidence = plainDirectory(request.evidenceDirectory, "evidenceDirectory");
  const filePath = path.join(evidence, name);
  fail(strictDescendant(evidence, filePath), "EC_ADAPTER_REQUEST_INVALID", "evidence path escapes evidenceDirectory");
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const status = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (status) {
    fail(status.isFile() && !status.isSymbolicLink(), "EC_ADAPTER_EVIDENCE_CONFLICT", "evidence path is not a regular file");
    fail(fs.readFileSync(filePath).equals(bytes), "EC_ADAPTER_EVIDENCE_CONFLICT", "immutable evidence file differs");
  } else {
    fs.writeFileSync(filePath, bytes, { flag: "wx", mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    syncDirectory(evidence);
  }
  return evidenceRef(filePath, bytes);
}

function outcome(request, manifest, state, evidenceRefs, result, failure = null, mutatedRemoteState = true) {
  return {
    schemaVersion: 1,
    protocolVersion: manifest.protocolVersion,
    operation: request.operation,
    operationId: request.operationId,
    backendId: manifest.backendId,
    outcome: result,
    mutatedRemoteState,
    retrySafe: result !== "indeterminate",
    data: { statePath: deploymentStatePath(request, manifest), state },
    evidenceRefs,
    failure,
  };
}

function safeUrl(value, label) {
  fail(typeof value === "string" && HTTPS_OR_LOOPBACK.test(value), "EC_ADAPTER_CONFIGURATION_INVALID", `${label} must be HTTPS or an HTTP loopback URL`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ProviderDeploymentError("EC_ADAPTER_CONFIGURATION_INVALID", `${label} is invalid: ${error.message}`);
  }
  fail(!parsed.username && !parsed.password && !parsed.hash, "EC_ADAPTER_CONFIGURATION_INVALID", `${label} must not contain credentials or a fragment`);
  return parsed;
}

export function validateDeploymentConfiguration(request, manifest) {
  fail(NAME.test(request.configuration.projectName), "EC_ADAPTER_CONFIGURATION_INVALID", "projectName must be a portable lowercase DNS label");
  const expected = operationProjectName(manifest.backendId, request.operationId);
  fail(request.configuration.projectName === expected, "EC_ADAPTER_CONFIGURATION_INVALID", `projectName must be the operation-owned name ${expected}`);
  if (manifest.backendId === "deislet") {
    safeUrl(request.configuration.controlUrl, "controlUrl");
    safeUrl(request.configuration.runtimeUrl, "runtimeUrl");
    safeUrl(request.configuration.telemetryUrl, "telemetryUrl");
    fail(NAME.test(request.configuration.environmentName), "EC_ADAPTER_CONFIGURATION_INVALID", "environmentName is invalid");
  }
  if (manifest.backendId === "tencent-edgeone-makers") {
    fail(["production", "preview"].includes(request.configuration.deploymentEnvironment), "EC_ADAPTER_CONFIGURATION_INVALID", "deploymentEnvironment is invalid");
    fail(["global", "overseas"].includes(request.configuration.area), "EC_ADAPTER_CONFIGURATION_INVALID", "area is invalid");
    fail(Object.hasOwn(EDGEONE_API, request.configuration.apiRegion), "EC_ADAPTER_CONFIGURATION_INVALID", "apiRegion is invalid");
  }
}

export function operationProjectName(backendId, operationId) {
  const labels = {
    "cloudflare-workers-pages": "cf",
    "tencent-edgeone-makers": "eo",
    deislet: "deis",
  };
  fail(Object.hasOwn(labels, backendId), "EC_ADAPTER_REQUEST_INVALID", "backendId is unknown");
  return `edge-canon-${labels[backendId]}-${sha256(Buffer.from(`${backendId}\0${operationId}`, "utf8")).slice(0, 16)}`;
}

async function boundedFetch(url, options, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    throw new ProviderDeploymentError("EC_ADAPTER_REMOTE_QUERY_FAILED", `remote identity query failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseTextBounded(response, maximumBytes, timeoutMs) {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  fail(!Number.isFinite(declared) || declared <= maximumBytes, "EC_ADAPTER_TOOL_OUTPUT_LIMIT", "remote response exceeds the adapter output limit");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const timedOut = Symbol("response-timeout");
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs);
  });
  try {
    while (true) {
      const pendingRead = reader.read();
      const result = await Promise.race([pendingRead, deadline]);
      if (result === timedOut) {
        await reader.cancel();
        await pendingRead.catch(() => undefined);
        throw new ProviderDeploymentError("EC_ADAPTER_REMOTE_QUERY_FAILED", "remote response body timed out");
      }
      const { done, value } = result;
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new ProviderDeploymentError("EC_ADAPTER_TOOL_OUTPUT_LIMIT", "remote response exceeds the adapter output limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function assertResourceAbsent(request, manifest, hostEnvironment, fetchImpl) {
  const name = request.configuration.projectName;
  const timeoutMs = Math.min(manifest.security.timeoutSeconds * 1_000, 30_000);
  if (manifest.backendId === "cloudflare-workers-pages") {
    const account = encodeURIComponent(hostEnvironment.CLOUDFLARE_ACCOUNT_ID);
    const script = encodeURIComponent(name);
    const response = await boundedFetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}/settings`,
      { headers: { Authorization: `Bearer ${hostEnvironment.CLOUDFLARE_API_TOKEN}` } },
      timeoutMs,
      fetchImpl,
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return;
    }
    if (response.ok) {
      await response.body?.cancel();
      throw new ProviderDeploymentError("EC_ADAPTER_RESOURCE_CONFLICT", `operation-owned Cloudflare Worker ${name} already exists`);
    }
    await response.body?.cancel();
    throw new ProviderDeploymentError("EC_ADAPTER_REMOTE_QUERY_FAILED", `Cloudflare identity query returned HTTP ${response.status}`);
  }
  if (manifest.backendId === "deislet") {
    const control = safeUrl(request.configuration.controlUrl, "controlUrl");
    const response = await boundedFetch(
      new URL(`/api/apps/${encodeURIComponent(name)}`, control),
      {
        headers: {
          Authorization: `Bearer ${hostEnvironment[
            request.operation === "cleanup" ? "DEIS_ADMIN_TOKEN" : "DEIS_DEPLOY_TOKEN"
          ]}`,
        },
      },
      timeoutMs,
      fetchImpl,
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return;
    }
    if (response.ok) {
      await response.body?.cancel();
      throw new ProviderDeploymentError("EC_ADAPTER_RESOURCE_CONFLICT", `operation-owned Deislet application ${name} already exists`);
    }
    await response.body?.cancel();
    throw new ProviderDeploymentError("EC_ADAPTER_REMOTE_QUERY_FAILED", `Deislet identity query returned HTTP ${response.status}`);
  }
  const api = EDGEONE_API[request.configuration.apiRegion];
  const response = await boundedFetch(
    api.endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${hostEnvironment.EDGEONE_PAGES_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        Action: "DescribePagesProjects",
        Filters: [{ Name: "Name", Values: [name] }],
        Offset: 0,
        Limit: 10,
        Region: api.region,
      }),
    },
    timeoutMs,
    fetchImpl,
  );
  fail(response.ok, "EC_ADAPTER_REMOTE_QUERY_FAILED", `EdgeOne identity query returned HTTP ${response.status}`);
  let document;
  try {
    document = JSON.parse(await readResponseTextBounded(response, manifest.security.maxOutputBytes, timeoutMs));
  } catch (error) {
    throw new ProviderDeploymentError("EC_ADAPTER_REMOTE_QUERY_FAILED", `EdgeOne identity query returned invalid JSON: ${error.message}`);
  }
  const body = document?.Data?.Response ?? document;
  fail(!body?.Error && (body?.Code === undefined || body.Code === 0), "EC_ADAPTER_REMOTE_QUERY_FAILED", "EdgeOne identity query returned an API error");
  fail(Array.isArray(body?.Projects), "EC_ADAPTER_REMOTE_QUERY_FAILED", "EdgeOne identity query response has no project list");
  fail(!body.Projects.some((project) => project?.Name === name), "EC_ADAPTER_RESOURCE_CONFLICT", `operation-owned EdgeOne project ${name} already exists`);
}

function parseJsonDocument(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProviderDeploymentError("EC_ADAPTER_TOOL_RESULT_INVALID", `${label} is not JSON: ${error.message}`);
  }
}

function finalJsonLine(text, label) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // CLI progress may precede its documented final JSON line.
    }
  }
  throw new ProviderDeploymentError("EC_ADAPTER_TOOL_RESULT_INVALID", `${label} has no JSON result line`);
}

function commandFor(request, manifest, tool, environment, inputDirectory) {
  const configuration = request.configuration;
  const baseArgs = tool.baseArgs ?? [];
  if (manifest.backendId === "cloudflare-workers-pages") {
    const outputPath = path.join(request.evidenceDirectory, ".wrangler-deploy-output.ndjson");
    const status = fs.lstatSync(outputPath, { throwIfNoEntry: false });
    fail(!status, "EC_ADAPTER_EVIDENCE_CONFLICT", "temporary Wrangler output already exists");
    fs.writeFileSync(outputPath, "", { flag: "wx", mode: 0o600 });
    fs.chmodSync(outputPath, 0o600);
    environment.WRANGLER_OUTPUT_FILE_PATH = outputPath;
    environment.WRANGLER_SEND_METRICS = "false";
    return {
      args: [
        ...baseArgs,
        "deploy",
        "--config", path.join(inputDirectory, "wrangler.json"),
        "--name", configuration.projectName,
        "--tag", `edge-canon-${sha256(Buffer.from(request.operationId)).slice(0, 16)}`,
        "--message", `Edge Canon ${request.operationId}`,
        "--strict",
      ],
      outputPath,
    };
  }
  if (manifest.backendId === "tencent-edgeone-makers") {
    environment.EDGEONE_PAGES_API_REGION = configuration.apiRegion;
    return {
      args: [
        ...baseArgs,
        "makers", "deploy", inputDirectory,
        "--name", configuration.projectName,
        "--env", configuration.deploymentEnvironment,
        "--area", configuration.area,
        "--json",
      ],
      outputPath: null,
    };
  }
  environment.DEIS_CONTROL_ENDPOINT = configuration.controlUrl;
  environment.DEIS_CONTROL_TOKEN = environment.DEIS_DEPLOY_TOKEN;
  delete environment.DEIS_DEPLOY_TOKEN;
  return {
    args: [
      ...baseArgs,
      "deploy",
      "--app", configuration.projectName,
      "--environment", configuration.environmentName,
      "--note", `Edge Canon ${request.operationId}`,
      "--json",
    ],
    outputPath: null,
  };
}

function parseDeployment(request, manifest, execution, outputPath) {
  if (manifest.backendId === "cloudflare-workers-pages") {
    let lines;
    try {
      lines = fs.readFileSync(outputPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      throw new ProviderDeploymentError("EC_ADAPTER_TOOL_RESULT_INVALID", `Wrangler structured output is invalid: ${error.message}`);
    } finally {
      try {
        fs.unlinkSync(outputPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    const record = lines.findLast((entry) => entry?.type === "deploy");
    const target = Array.isArray(record?.targets) ? record.targets.find((value) => typeof value === "string") : null;
    fail(typeof record?.version_id === "string" && record.version_id, "EC_ADAPTER_TOOL_RESULT_INVALID", "Wrangler deploy output has no version identity");
    fail(record.worker_name === undefined || record.worker_name === request.configuration.projectName, "EC_ADAPTER_TOOL_RESULT_INVALID", "Wrangler deploy worker identity differs");
    fail(typeof target === "string", "EC_ADAPTER_TOOL_RESULT_INVALID", "Wrangler deploy output has no target URL");
    safeUrl(target, "Wrangler deployment URL");
    return {
      projectId: record.worker_name ?? request.configuration.projectName,
      deploymentId: record.version_id,
      versionId: record.version_id,
      url: target,
      environment: record.wrangler_environment ?? "production",
    };
  }
  if (manifest.backendId === "tencent-edgeone-makers") {
    const document = finalJsonLine(execution.stdout, "EdgeOne deploy output");
    fail(document.status === "success", "EC_ADAPTER_TOOL_RESULT_INVALID", "EdgeOne deploy did not report success");
    for (const key of ["projectId", "deploymentId", "url"]) {
      fail(typeof document[key] === "string" && document[key], "EC_ADAPTER_TOOL_RESULT_INVALID", `EdgeOne deploy output has no ${key}`);
    }
    safeUrl(document.url, "EdgeOne deployment URL");
    return {
      projectId: document.projectId,
      deploymentId: document.deploymentId,
      versionId: null,
      url: document.url,
      environment: request.configuration.deploymentEnvironment,
    };
  }
  const document = parseJsonDocument(execution.stdout, "Deislet deploy output");
  fail(document.app === request.configuration.projectName, "EC_ADAPTER_TOOL_RESULT_INVALID", "Deislet deploy app identity differs");
  fail(document.environment === request.configuration.environmentName, "EC_ADAPTER_TOOL_RESULT_INVALID", "Deislet deploy environment differs");
  fail(typeof document.version?.id === "string" && document.version.id, "EC_ADAPTER_TOOL_RESULT_INVALID", "Deislet deploy output has no version identity");
  const runtime = safeUrl(request.configuration.runtimeUrl, "runtimeUrl");
  return {
    projectId: document.app,
    deploymentId: document.deployment?.id ?? document.version.id,
    versionId: document.version.id,
    url: runtime.href,
    environment: document.environment,
  };
}

function commandEvidence(execution) {
  return {
    schemaVersion: 1,
    exitCode: execution.exitCode,
    signal: execution.signal,
    termination: execution.termination,
    stdout: execution.stdout,
    stderr: execution.stderr,
    durationMs: execution.durationMs,
  };
}

function processFailure(execution, operation) {
  if (execution.termination === "timeout") return { code: "EC_ADAPTER_TOOL_TIMEOUT", message: `${operation} timed out; remote state must be reconciled` };
  if (execution.termination === "output-limit") return { code: "EC_ADAPTER_TOOL_OUTPUT_LIMIT", message: `${operation} exceeded its output limit; remote state must be reconciled` };
  return { code: "EC_ADAPTER_REMOTE_RESULT_UNKNOWN", message: `${operation} exited without a verified provider identity; remote state must be reconciled` };
}

export async function deployProvider({
  request,
  manifest,
  tool,
  environment,
  hostEnvironment,
  processRunner = runProviderProcess,
  fetchImpl = fetch,
}) {
  validateDeploymentConfiguration(request, manifest);
  const artifact = validatePreparedProviderArtifact({ request, manifest });
  const filePath = deploymentStatePath(request, manifest);
  const releaseLock = acquireOperationLock(filePath);
  try {
    const existing = readState(filePath, request, manifest, artifact);
    if (existing?.status === "deployed") return outcome(request, manifest, existing, [], "succeeded", null, false);
    if (existing?.status === "cleaned") {
      throw new ProviderDeploymentError("EC_ADAPTER_STATE_INVALID", "a cleaned operation identity cannot be deployed again");
    }
    if (existing) {
      return outcome(
        request,
        manifest,
        existing,
        [],
        "indeterminate",
        { code: "EC_ADAPTER_REMOTE_RECONCILIATION_REQUIRED", message: "a prior deployment attempt has no verified terminal identity; it was not repeated" },
        false,
      );
    }

    await assertResourceAbsent(request, manifest, hostEnvironment, fetchImpl);
    const inputDirectory = createDeploymentInput(request, manifest);
    let state = initialState(request, manifest, artifact);
    writeJsonAtomic(filePath, state);
    const command = commandFor(request, manifest, tool, environment, inputDirectory);
    let execution;
    try {
      execution = await processRunner({
        executable: tool.executable,
        args: command.args,
        cwd: inputDirectory,
        environment,
        credentialEnvironment: manifest.backendId === "deislet"
          ? ["DEIS_CONTROL_TOKEN"]
          : manifest.credentialEnvironment.deploy,
        timeoutMs: manifest.security.timeoutSeconds * 1_000,
        maxOutputBytes: manifest.security.maxOutputBytes,
      });
    } catch (error) {
      removeTemporaryOutput(command.outputPath);
      state = transition(filePath, state, "deploy-indeterminate");
      return outcome(
        request,
        manifest,
        state,
        [],
        "indeterminate",
        { code: "EC_ADAPTER_REMOTE_RESULT_UNKNOWN", message: `deploy process could not be observed to completion: ${error.message}` },
      );
    }
    const evidence = writeEvidence(request, `${manifest.backendId}-deploy-command.json`, commandEvidence(execution));
    let provider;
    try {
      provider = parseDeployment(request, manifest, execution, command.outputPath);
    } catch (error) {
      state = transition(filePath, state, "deploy-indeterminate");
      return outcome(request, manifest, state, [evidence], "indeterminate", processFailure(execution, "deploy"));
    }
    state = transition(filePath, state, execution.exitCode === 0 && execution.termination === null ? "deployed" : "deploy-indeterminate", provider);
    if (state.status !== "deployed") {
      return outcome(request, manifest, state, [evidence], "indeterminate", processFailure(execution, "deploy"));
    }
    return outcome(request, manifest, state, [evidence], "succeeded");
  } finally {
    releaseLock();
  }
}

async function resourceExistsForCleanup(request, manifest, hostEnvironment, fetchImpl) {
  try {
    await assertResourceAbsent(request, manifest, hostEnvironment, fetchImpl);
    return false;
  } catch (error) {
    if (error instanceof ProviderDeploymentError && error.code === "EC_ADAPTER_RESOURCE_CONFLICT") return true;
    throw error;
  }
}

function cleanupCommand(request, manifest, tool, environment) {
  const baseArgs = tool.baseArgs ?? [];
  if (manifest.backendId === "cloudflare-workers-pages") {
    environment.WRANGLER_SEND_METRICS = "false";
    return [...baseArgs, "delete", request.configuration.projectName, "--force"];
  }
  if (manifest.backendId === "deislet") {
    environment.DEIS_CONTROL_ENDPOINT = request.configuration.controlUrl;
    return null;
  }
  throw new ProviderDeploymentError("EC_ADAPTER_OPERATION_UNIMPLEMENTED", "EdgeOne does not publish a non-interactive project cleanup command or API contract");
}

export async function cleanupProvider({
  request,
  manifest,
  tool,
  environment,
  hostEnvironment,
  processRunner = runProviderProcess,
  fetchImpl = fetch,
}) {
  validateDeploymentConfiguration(request, manifest);
  const artifact = validatePreparedProviderArtifact({ request, manifest });
  const filePath = deploymentStatePath(request, manifest);
  const releaseLock = acquireOperationLock(filePath);
  try {
    let state = readState(filePath, request, manifest, artifact);
    fail(state, "EC_ADAPTER_STATE_MISSING", "cleanup has no deployment state for this operation identity");
    if (state.status === "cleaned") return outcome(request, manifest, state, [], "succeeded", null, false);
    const exists = await resourceExistsForCleanup(request, manifest, hostEnvironment, fetchImpl);
    if (!exists) {
      if (manifest.backendId === "deislet") {
        return outcome(
          request,
          manifest,
          state,
          [],
          "indeterminate",
          {
            code: "EC_ADAPTER_REMOTE_RECONCILIATION_REQUIRED",
            message: "the Deislet catalog entry is absent but no node-unload receipt is bound to this cleanup attempt",
          },
          false,
        );
      }
      state = transition(filePath, state, "cleaned", emptyProvider(state.provider.environment));
      return outcome(request, manifest, state, [], "succeeded", null, false);
    }
    if (["cleaning", "cleanup-indeterminate"].includes(state.status)) {
      return outcome(
        request,
        manifest,
        state,
        [],
        "indeterminate",
        {
          code: "EC_ADAPTER_REMOTE_RECONCILIATION_REQUIRED",
          message: "a prior cleanup attempt has no verified terminal result; it was not repeated",
        },
        false,
      );
    }
    state = transition(filePath, state, "cleaning");
    const args = cleanupCommand(request, manifest, tool, environment);
    let execution;
    try {
      if (manifest.backendId === "deislet") {
        const control = safeUrl(request.configuration.controlUrl, "controlUrl");
        const response = await boundedFetch(
          new URL(`/api/apps/${encodeURIComponent(request.configuration.projectName)}`, control),
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${hostEnvironment.DEIS_ADMIN_TOKEN}` },
          },
          Math.min(manifest.security.timeoutSeconds * 1_000, 30_000),
          fetchImpl,
        );
        let verified = false;
        let summary = {};
        if (response.ok) {
          try {
            const text = await readResponseTextBounded(
              response,
              manifest.security.maxOutputBytes,
              Math.min(manifest.security.timeoutSeconds * 1_000, 30_000),
            );
            const receipt = JSON.parse(text);
            const failed = receipt?.unloaded?.failed;
            verified = receipt?.app_id === request.configuration.projectName && Array.isArray(failed) && failed.length === 0;
            summary = {
              appId: receipt?.app_id ?? null,
              unloadedNodes: Array.isArray(receipt?.unloaded?.unloaded) ? receipt.unloaded.unloaded.length : null,
              failedNodes: Array.isArray(failed) ? failed.length : null,
              retainedData: receipt?.retained !== undefined,
            };
          } catch (error) {
            summary = { receiptError: error.message };
          }
        }
        execution = {
          exitCode: verified ? 0 : 1,
          signal: null,
          termination: null,
          stdout: verified ? JSON.stringify(summary) : "",
          stderr: verified ? "" : `Control API deletion lacked a complete node-unload receipt (HTTP ${response.status})`,
          durationMs: 0,
        };
      } else {
        execution = await processRunner({
          executable: tool.executable,
          args,
          cwd: request.configuration.derivedDirectory,
          environment,
          credentialEnvironment: manifest.credentialEnvironment.cleanup,
          timeoutMs: manifest.security.timeoutSeconds * 1_000,
          maxOutputBytes: manifest.security.maxOutputBytes,
        });
      }
    } catch (error) {
      state = transition(filePath, state, "cleanup-indeterminate");
      return outcome(
        request,
        manifest,
        state,
        [],
        "indeterminate",
        { code: "EC_ADAPTER_REMOTE_RESULT_UNKNOWN", message: `cleanup could not be observed to completion: ${error.message}` },
      );
    }
    const evidence = writeEvidence(request, `${manifest.backendId}-cleanup-command.json`, commandEvidence(execution));
    if (execution.exitCode !== 0 || execution.termination !== null) {
      state = transition(filePath, state, "cleanup-indeterminate");
      return outcome(request, manifest, state, [evidence], "indeterminate", processFailure(execution, "cleanup"));
    }
    const stillExists = await resourceExistsForCleanup(request, manifest, hostEnvironment, fetchImpl);
    if (stillExists) {
      state = transition(filePath, state, "cleanup-indeterminate");
      return outcome(
        request,
        manifest,
        state,
        [evidence],
        "indeterminate",
        { code: "EC_ADAPTER_REMOTE_RESULT_UNKNOWN", message: "cleanup command succeeded but the operation-owned resource still exists" },
      );
    }
    state = transition(filePath, state, "cleaned", emptyProvider(state.provider.environment));
    return outcome(request, manifest, state, [evidence], "succeeded");
  } finally {
    releaseLock();
  }
}
