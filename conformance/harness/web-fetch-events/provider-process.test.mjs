import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AdapterError, runAdapter } from "./provider-adapter-cli.mjs";
import { AdapterProcessError, runProviderProcess } from "./provider-process.mjs";

const cwd = process.cwd();

function processOptions(overrides = {}) {
  return {
    executable: process.execPath,
    args: ["-e", ""],
    cwd,
    environment: { PATH: process.env.PATH ?? "", TEST_TOKEN: "secret-canary-value" },
    credentialEnvironment: ["TEST_TOKEN"],
    timeoutMs: 2_000,
    maxOutputBytes: 4_096,
    ...overrides,
  };
}

test("provider subprocess output is redacted before it is returned", async () => {
  const result = await runProviderProcess(processOptions({
    args: [
      "-e",
      "process.stdout.write(process.env.TEST_TOKEN); process.stderr.write(`error:${process.env.TEST_TOKEN}`)",
    ],
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "[REDACTED]");
  assert.equal(result.stderr, "error:[REDACTED]");
  assert.doesNotMatch(JSON.stringify(result), /secret-canary-value/);
});

test("a credential value is rejected in an argument before spawn", async () => {
  await assert.rejects(
    runProviderProcess(processOptions({ args: ["secret-canary-value"] })),
    (error) => error instanceof AdapterProcessError && error.code === "EC_ADAPTER_SECRET_IN_ARGUMENT",
  );
});

test("provider output is bounded without returning a possibly partial secret", async () => {
  const result = await runProviderProcess(processOptions({
    args: ["-e", "process.stdout.write('x'.repeat(4096))"],
    maxOutputBytes: 128,
  }));
  assert.equal(result.termination, "output-limit");
  assert.equal(result.stdout, "[output omitted: adapter limit exceeded]");
  assert.equal(result.stderr, "[output omitted: adapter limit exceeded]");
});

test("a timed-out provider process is terminated", async () => {
  const result = await runProviderProcess(processOptions({
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 30,
  }));
  assert.equal(result.termination, "timeout");
  assert.notEqual(result.signal, null);
});

test("Cloudflare preflight verifies the package lock and keeps credentials out of the result", async (context) => {
  const root = fs.mkdtempSync(path.join(cwd, ".edge-canon-adapter-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "node_modules", "wrangler");
  const evidenceDirectory = path.join(root, "evidence");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(evidenceDirectory);
  const entrypoint = path.join(packageRoot, "cli.mjs");
  const packageJson = path.join(packageRoot, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const artifact = path.join(root, "artifact.zip");
  fs.writeFileSync(entrypoint, "process.stdout.write('wrangler 4.129.0\\n');\n");
  fs.writeFileSync(packageJson, JSON.stringify({ name: "wrangler", version: "4.129.0" }));
  fs.writeFileSync(lockPath, JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "node_modules/wrangler": {
        version: "4.129.0",
        integrity: "sha512-PGPvs9UPoFrwxT0VogpESSZGvZIctAuTK3wGsLLPHtHsSgS85kNdvtpa2d14UzG8gwLWD64XUGFPGG9tOXG9VQ==",
      },
    },
  }));
  fs.writeFileSync(artifact, "canonical artifact test fixture");

  const request = {
    schemaVersion: 1,
    protocolVersion: "edge-canon.provider-adapter/v1",
    operation: "preflight",
    operationId: "preflight-test",
    standardVersion: "edge-canon.next@c9470b21d27bfd1dc493c8dd33d9390ffb8fa3d1",
    suiteId: "EC-WEB",
    backendId: "cloudflare-workers-pages",
    canonicalArtifact: { path: artifact, sha256: "1".repeat(64) },
    workDirectory: root,
    evidenceDirectory,
    configuration: {
      toolEntrypoint: entrypoint,
      toolPackageJson: packageJson,
      toolLockPath: lockPath,
      projectName: "edge-canon-preflight-test",
    },
  };
  const manifestPath = fileURLToPath(new URL(
    "./provider-adapters/cloudflare-workers-pages/adapter.json",
    import.meta.url,
  ));
  const result = await runAdapter({
    manifestPath,
    request,
    hostEnvironment: {
      PATH: process.env.PATH ?? "",
      CLOUDFLARE_ACCOUNT_ID: "account-secret-canary",
      CLOUDFLARE_API_TOKEN: "token-secret-canary",
    },
  });
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.data.toolVersion, "4.129.0");
  assert.deepEqual(result.data.credentialEnvironment, ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(result), /account-secret-canary|token-secret-canary/);

  request.operation = "deploy";
  await assert.rejects(
    runAdapter({ manifestPath, request, hostEnvironment: {} }),
    (error) => error instanceof AdapterError && error.code === "EC_ADAPTER_OPERATION_UNIMPLEMENTED",
  );
});
