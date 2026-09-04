import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sha256 } from "./canonical-artifact.mjs";
import { acquireOperationLock, deploymentStatePath } from "./provider-deployment.mjs";
import { redactText } from "./provider-process.mjs";

const STATE_FORMAT = "edge-canon.provider-run-state/v1";
const PHASES = ["preflight", "prepare", "deploy", "invoke", "collect", "cleanup"];

export class ProviderRunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderRunError";
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (!condition) throw new ProviderRunError(code, message);
}

function now() {
  return new Date().toISOString();
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

function privateDirectory(directory) {
  const status = fs.lstatSync(directory, { throwIfNoEntry: false });
  fail(status?.isDirectory() && !status.isSymbolicLink(), "EC_ADAPTER_REQUEST_INVALID", "evidenceDirectory is not a regular directory");
  fail(fs.realpathSync(directory) === path.resolve(directory), "EC_ADAPTER_REQUEST_INVALID", "evidenceDirectory traverses a symbolic link");
  fs.chmodSync(directory, 0o700);
  return path.resolve(directory);
}

export function runStatePath(request, manifest) {
  const root = privateDirectory(request.evidenceDirectory);
  const key = sha256(Buffer.from(`${manifest.backendId}\0${request.operationId}`, "utf8")).slice(0, 32);
  return path.join(root, `${manifest.backendId}-${key}-run.json`);
}

function writeState(filePath, state) {
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  fail(bytes.byteLength <= 16 * 1024 * 1024, "EC_ADAPTER_TOOL_OUTPUT_LIMIT", "run state exceeds the evidence limit");
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

function phaseResult(value, phase, request, manifest) {
  fail(value && typeof value === "object" && !Array.isArray(value), "EC_ADAPTER_INTERNAL", `${phase} returned no result`);
  fail(value.schemaVersion === 1 && value.protocolVersion === manifest.protocolVersion, "EC_ADAPTER_INTERNAL", `${phase} result protocol differs`);
  fail(value.operation === phase && value.operationId === request.operationId && value.backendId === manifest.backendId, "EC_ADAPTER_INTERNAL", `${phase} result identity differs`);
  fail(["succeeded", "failed", "indeterminate"].includes(value.outcome), "EC_ADAPTER_INTERNAL", `${phase} result outcome is invalid`);
  fail(typeof value.mutatedRemoteState === "boolean" && typeof value.retrySafe === "boolean", "EC_ADAPTER_INTERNAL", `${phase} result recovery metadata is invalid`);
  fail(value.data && typeof value.data === "object" && !Array.isArray(value.data), "EC_ADAPTER_INTERNAL", `${phase} result data is invalid`);
  fail(Array.isArray(value.evidenceRefs) && value.evidenceRefs.every((item) => typeof item === "string"), "EC_ADAPTER_INTERNAL", `${phase} result evidence references are invalid`);
  fail(value.failure === null || (typeof value.failure?.code === "string" && typeof value.failure?.message === "string"), "EC_ADAPTER_INTERNAL", `${phase} result failure is invalid`);
  return value;
}

function failureOf(error, secrets) {
  const code = typeof error?.code === "string" && /^EC_ADAPTER_[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : "EC_ADAPTER_INTERNAL";
  return {
    code,
    message: redactText(error instanceof Error ? error.message : String(error), secrets).slice(0, 2048),
  };
}

function result(request, manifest, filePath, state, mutatedRemoteState) {
  return {
    schemaVersion: 1,
    protocolVersion: manifest.protocolVersion,
    operation: "run",
    operationId: request.operationId,
    backendId: manifest.backendId,
    outcome: state.status,
    mutatedRemoteState,
    retrySafe: state.status !== "indeterminate",
    data: {
      statePath: filePath,
      state,
      observationsPath: state.observationsPath,
    },
    evidenceRefs: state.evidenceRefs,
    failure: state.failure,
  };
}

function validateState(state, request, manifest) {
  const keys = [
    "schemaVersion", "stateFormat", "operationId", "backendId", "standardVersion", "suiteId",
    "canonicalArtifactSha256", "status", "currentPhase", "phaseResults", "observationsPath",
    "evidenceRefs", "failure", "createdAt", "updatedAt",
  ];
  fail(state && typeof state === "object" && !Array.isArray(state), "EC_ADAPTER_STATE_INVALID", "run state is not an object");
  fail(JSON.stringify(Object.keys(state).sort()) === JSON.stringify(keys.sort()), "EC_ADAPTER_STATE_INVALID", "run state keys differ");
  fail(state.schemaVersion === 1 && state.stateFormat === STATE_FORMAT, "EC_ADAPTER_STATE_INVALID", "run state format differs");
  fail(state.operationId === request.operationId && state.backendId === manifest.backendId, "EC_ADAPTER_STATE_INVALID", "run state operation identity differs");
  fail(state.standardVersion === request.standardVersion && state.suiteId === request.suiteId, "EC_ADAPTER_STATE_INVALID", "run state standard identity differs");
  fail(state.canonicalArtifactSha256 === request.canonicalArtifact.sha256, "EC_ADAPTER_STATE_INVALID", "run state canonical artifact differs");
  fail(["running", "succeeded", "failed", "indeterminate"].includes(state.status), "EC_ADAPTER_STATE_INVALID", "run state status is invalid");
  fail(state.currentPhase === null || PHASES.includes(state.currentPhase), "EC_ADAPTER_STATE_INVALID", "run state current phase is invalid");
  fail(Array.isArray(state.phaseResults), "EC_ADAPTER_STATE_INVALID", "run state phase results are invalid");
  let previous = -1;
  for (const entry of state.phaseResults) {
    fail(entry && typeof entry === "object" && PHASES.includes(entry.phase), "EC_ADAPTER_STATE_INVALID", "run state contains an invalid phase result");
    const index = PHASES.indexOf(entry.phase);
    fail(index > previous, "EC_ADAPTER_STATE_INVALID", "run state phase results are duplicated or out of order");
    previous = index;
    phaseResult(entry.result, entry.phase, request, manifest);
    fail(Number.isFinite(Date.parse(entry.completedAt)), "EC_ADAPTER_STATE_INVALID", "run phase timestamp is invalid");
  }
  fail(state.observationsPath === null || (typeof state.observationsPath === "string" && path.isAbsolute(state.observationsPath)), "EC_ADAPTER_STATE_INVALID", "run observations path is invalid");
  fail(Array.isArray(state.evidenceRefs) && state.evidenceRefs.every((item) => typeof item === "string"), "EC_ADAPTER_STATE_INVALID", "run evidence references are invalid");
  fail(state.failure === null || (typeof state.failure?.code === "string" && typeof state.failure?.message === "string"), "EC_ADAPTER_STATE_INVALID", "run failure is invalid");
  fail(Number.isFinite(Date.parse(state.createdAt)) && Number.isFinite(Date.parse(state.updatedAt)), "EC_ADAPTER_STATE_INVALID", "run state timestamps are invalid");
  return state;
}

function readState(filePath, request, manifest) {
  const status = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!status) return null;
  fail(status.isFile() && !status.isSymbolicLink(), "EC_ADAPTER_STATE_INVALID", "run state is not a regular file");
  fail(status.size <= 16 * 1024 * 1024, "EC_ADAPTER_STATE_INVALID", "run state is oversized");
  fail(fs.realpathSync(filePath) === path.resolve(filePath), "EC_ADAPTER_STATE_INVALID", "run state traverses a symbolic link");
  try {
    return validateState(JSON.parse(fs.readFileSync(filePath, "utf8")), request, manifest);
  } catch (error) {
    if (error instanceof ProviderRunError) throw error;
    throw new ProviderRunError("EC_ADAPTER_STATE_INVALID", `run state is not readable JSON: ${error.message}`);
  }
}

function initialState(request, manifest) {
  const timestamp = now();
  return {
    schemaVersion: 1,
    stateFormat: STATE_FORMAT,
    operationId: request.operationId,
    backendId: manifest.backendId,
    standardVersion: request.standardVersion,
    suiteId: request.suiteId,
    canonicalArtifactSha256: request.canonicalArtifact.sha256,
    status: "running",
    currentPhase: null,
    phaseResults: [],
    observationsPath: null,
    evidenceRefs: [],
    failure: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function phaseRequest(request, phase) {
  return { ...request, operation: phase };
}

function recordPhase(filePath, state, phase, phaseValue) {
  const entry = { phase, completedAt: now(), result: phaseValue };
  const existing = state.phaseResults.findIndex((item) => item.phase === phase);
  const phaseResults = existing < 0
    ? [...state.phaseResults, entry].sort((left, right) => PHASES.indexOf(left.phase) - PHASES.indexOf(right.phase))
    : state.phaseResults.map((item, index) => index === existing ? entry : item);
  const next = {
    ...state,
    currentPhase: phase,
    phaseResults,
    updatedAt: now(),
  };
  writeState(filePath, next);
  return next;
}

/** Coordinate every provider phase and always attempt cleanup after deploy. */
export async function runProvider({
  request,
  manifest,
  phase,
  credentials = [],
}) {
  fail(typeof phase === "function", "EC_ADAPTER_INTERNAL", "run has no phase executor");
  const filePath = runStatePath(request, manifest);
  const releaseLock = acquireOperationLock(filePath);
  try {
    let state = readState(filePath, request, manifest);
    if (state && state.status !== "running") {
      const mutated = state.phaseResults.some((entry) => entry.result.mutatedRemoteState);
      return result(request, manifest, filePath, state, mutated);
    }
    state ??= initialState(request, manifest);
    writeState(filePath, state);
    const secrets = credentials.filter((value) => typeof value === "string" && value.length > 0);
    let primaryOutcome = "succeeded";
    let primaryFailure = null;
    const prior = new Map(state.phaseResults.map((entry) => [entry.phase, entry.result]));
    for (const name of PHASES.slice(0, -1)) {
      const value = prior.get(name);
      if (!value || value.outcome === "succeeded") continue;
      primaryOutcome = value.outcome;
      primaryFailure = value.failure ?? { code: "EC_ADAPTER_INTERNAL", message: `${name} did not succeed` };
      break;
    }
    let deployed = prior.has("deploy")
      || (fs.statSync(deploymentStatePath(request, manifest), { throwIfNoEntry: false })?.isFile() ?? false);
    for (const name of PHASES.slice(0, -1)) {
      if (primaryOutcome !== "succeeded") break;
      if (prior.has(name)) continue;
      state = { ...state, currentPhase: name, updatedAt: now() };
      writeState(filePath, state);
      try {
        const value = phaseResult(await phase(name, phaseRequest(request, name)), name, request, manifest);
        state = recordPhase(filePath, state, name, value);
        if (name === "deploy") {
          deployed = value.mutatedRemoteState
            || (fs.statSync(deploymentStatePath(request, manifest), { throwIfNoEntry: false })?.isFile() ?? false);
        }
        if (name === "collect" && typeof value.data?.observationsPath === "string") {
          state = { ...state, observationsPath: value.data.observationsPath, updatedAt: now() };
          writeState(filePath, state);
        }
        if (value.outcome !== "succeeded") {
          primaryOutcome = value.outcome;
          primaryFailure = value.failure ?? { code: "EC_ADAPTER_INTERNAL", message: `${name} did not succeed` };
        }
      } catch (error) {
        if (name === "deploy") {
          deployed = fs.statSync(deploymentStatePath(request, manifest), { throwIfNoEntry: false })?.isFile() ?? false;
        }
        primaryOutcome = "failed";
        primaryFailure = failureOf(error, secrets);
      }
    }

    let cleanupOutcome = prior.get("cleanup")?.outcome ?? "succeeded";
    let cleanupFailure = prior.get("cleanup")?.failure ?? null;
    if (deployed && !prior.has("cleanup")) {
      state = { ...state, currentPhase: "cleanup", updatedAt: now() };
      writeState(filePath, state);
      try {
        const value = phaseResult(await phase("cleanup", phaseRequest(request, "cleanup")), "cleanup", request, manifest);
        state = recordPhase(filePath, state, "cleanup", value);
        cleanupOutcome = value.outcome;
        cleanupFailure = value.failure;
      } catch (error) {
        cleanupOutcome = "indeterminate";
        cleanupFailure = failureOf(error, secrets);
      }
    }

    const finalStatus = cleanupOutcome !== "succeeded"
      ? "indeterminate"
      : primaryOutcome;
    const failure = cleanupOutcome !== "succeeded"
      ? cleanupFailure ?? { code: "EC_ADAPTER_INTERNAL", message: "cleanup did not succeed" }
      : primaryFailure;
    const evidenceRefs = [...new Set(state.phaseResults.flatMap((entry) => entry.result.evidenceRefs ?? []))];
    state = {
      ...state,
      status: finalStatus,
      currentPhase: null,
      evidenceRefs,
      failure: finalStatus === "succeeded" ? null : failure,
      updatedAt: now(),
    };
    writeState(filePath, state);
    const mutatedRemoteState = state.phaseResults.some((entry) => entry.result.mutatedRemoteState);
    return result(request, manifest, filePath, state, mutatedRemoteState);
  } finally {
    releaseLock();
  }
}
