import { spawn } from "node:child_process";
import path from "node:path";

export class AdapterProcessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AdapterProcessError";
    this.code = code;
  }
}

function assertStringArray(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new AdapterProcessError("EC_ADAPTER_REQUEST_INVALID", `${label} must be an array of strings`);
  }
}

export function redactText(value, secrets) {
  let redacted = String(value);
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function stopProcessTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      killer.unref();
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the checks above.
    }
  }
}

/** Execute one pinned provider tool without a shell and with bounded output. */
export async function runProviderProcess({
  executable,
  args,
  cwd,
  environment,
  credentialEnvironment = [],
  timeoutMs,
  maxOutputBytes,
}) {
  if (typeof executable !== "string" || !path.isAbsolute(executable)) {
    throw new AdapterProcessError("EC_ADAPTER_TOOL_UNPINNED", "provider executable must be an absolute path");
  }
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new AdapterProcessError("EC_ADAPTER_REQUEST_INVALID", "provider cwd must be an absolute path");
  }
  assertStringArray(args, "args");
  assertStringArray(credentialEnvironment, "credentialEnvironment");
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new AdapterProcessError("EC_ADAPTER_REQUEST_INVALID", "environment must be an object");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new AdapterProcessError("EC_ADAPTER_REQUEST_INVALID", "timeoutMs must be a positive integer");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new AdapterProcessError("EC_ADAPTER_REQUEST_INVALID", "maxOutputBytes must be a positive integer");
  }

  const secrets = credentialEnvironment.map((name) => environment[name]).filter(Boolean);
  for (const [index, argument] of args.entries()) {
    if (secrets.some((secret) => argument.includes(secret))) {
      throw new AdapterProcessError(
        "EC_ADAPTER_SECRET_IN_ARGUMENT",
        `provider argument ${index} contains a credential value`,
      );
    }
  }

  const startedAt = Date.now();
  return await new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    let termination = null;
    let settled = false;

    const child = spawn(executable, args, {
      cwd,
      env: environment,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const terminate = (reason) => {
      if (termination) return;
      termination = reason;
      stdoutChunks.length = 0;
      stderrChunks.length = 0;
      stopProcessTree(child);
    };
    const capture = (chunks, kind) => (chunk) => {
      const bytes = Buffer.byteLength(chunk);
      if (kind === "stdout") stdoutBytes += bytes;
      else stderrBytes += bytes;
      if (stdoutBytes + stderrBytes > maxOutputBytes) {
        terminate("output-limit");
        return;
      }
      chunks.push(Buffer.from(chunk));
    };

    child.stdout.on("data", capture(stdoutChunks, "stdout"));
    child.stderr.on("data", capture(stderrChunks, "stderr"));
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AdapterProcessError("EC_ADAPTER_TOOL_START_FAILED", redactText(error.message, secrets)));
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const omitted = "[output omitted: adapter limit exceeded]";
      resolve({
        exitCode,
        signal,
        termination,
        stdout: termination === "output-limit"
          ? omitted
          : redactText(Buffer.concat(stdoutChunks).toString("utf8"), secrets),
        stderr: termination === "output-limit"
          ? omitted
          : redactText(Buffer.concat(stderrChunks).toString("utf8"), secrets),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
