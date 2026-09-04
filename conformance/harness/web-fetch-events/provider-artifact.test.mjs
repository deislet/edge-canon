import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

import { buildCanonicalArtifact, sha256 } from "./canonical-artifact.mjs";
import { AdapterError, runAdapter } from "./provider-adapter-cli.mjs";
import { ProviderArtifactError } from "./provider-artifact.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const revision = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const standardVersion = `edge-canon.next@${revision}`;
const providers = [
  {
    backendId: "cloudflare-workers-pages",
    entrypoint: "src/index.mjs",
    invoke(module, nativeContext) {
      return module.default.fetch(nativeContext.request, nativeContext.env, nativeContext);
    },
  },
  {
    backendId: "tencent-edgeone-makers",
    entrypoint: "edge-functions/[[default]].js",
    invoke(module, nativeContext) {
      return module.default(nativeContext);
    },
  },
  {
    backendId: "deislet",
    entrypoint: "functions/[[all]].js",
    invoke(module, nativeContext) {
      return module.default(nativeContext);
    },
  },
];

function makeRoot(context) {
  const root = fs.mkdtempSync(path.join(repositoryRoot, ".edge-canon-artifact-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonicalDirectory = path.join(root, "canonical");
  const canonical = buildCanonicalArtifact({ repositoryRoot, standardVersion, outputDirectory: canonicalDirectory });
  return { root, canonical };
}

function prepareRequest(root, canonical, provider, suffix = "one") {
  const workDirectory = path.join(root, `work-${provider.backendId}`);
  const evidenceDirectory = path.join(workDirectory, "evidence");
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  return {
    schemaVersion: 1,
    protocolVersion: "edge-canon.provider-adapter/v1",
    operation: "prepare",
    operationId: `prepare-${provider.backendId}-${suffix}`,
    standardVersion,
    suiteId: "EC-WEB",
    backendId: provider.backendId,
    canonicalArtifact: {
      path: canonical.canonicalArtifactPath,
      sha256: canonical.canonicalArtifactSha256,
    },
    workDirectory,
    evidenceDirectory,
    configuration: {
      derivedDirectory: path.join(workDirectory, `derived-${suffix}`),
      projectName: "edge-canon-conformance",
      compatibilityDate: "2026-09-01",
    },
  };
}

function manifestPath(provider) {
  return fileURLToPath(new URL(`./provider-adapters/${provider.backendId}/adapter.json`, import.meta.url));
}

test("canonical artifact is made from exact Git bytes with a stable digest", (context) => {
  const { root, canonical } = makeRoot(context);
  const manifestBytes = fs.readFileSync(canonical.canonicalArtifactPath);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(canonical.canonicalArtifactSha256, sha256(manifestBytes));
  assert.equal(manifest.standardVersion, standardVersion);
  assert.deepEqual(manifest.files.map((file) => file.path), ["cpu-workload.mjs", "fixture.mjs"]);
  for (const file of manifest.files) {
    const committed = execFileSync("git", ["-C", repositoryRoot, "show", `${revision}:conformance/harness/web-fetch-events/${file.path}`]);
    assert.deepEqual(fs.readFileSync(path.join(root, "canonical", file.path)), committed);
  }
});

for (const provider of providers) {
  test(`${provider.backendId} prepare is deterministic, credential-free and executable`, async (context) => {
    const { root, canonical } = makeRoot(context);
    const firstRequest = prepareRequest(root, canonical, provider, "one");
    const first = await runAdapter({ manifestPath: manifestPath(provider), request: firstRequest, hostEnvironment: {} });
    assert.equal(first.outcome, "succeeded");
    assert.equal(first.data.idempotent, false);
    assert.equal(first.data.entrypoint, provider.entrypoint);
    assert.equal(first.data.canonicalArtifactSha256, canonical.canonicalArtifactSha256);

    const again = await runAdapter({ manifestPath: manifestPath(provider), request: firstRequest, hostEnvironment: {} });
    assert.equal(again.data.idempotent, true);
    assert.equal(again.data.derivedArtifactSha256, first.data.derivedArtifactSha256);

    const secondRequest = prepareRequest(root, canonical, provider, "two");
    const second = await runAdapter({ manifestPath: manifestPath(provider), request: secondRequest, hostEnvironment: {} });
    assert.equal(second.data.derivedArtifactSha256, first.data.derivedArtifactSha256);
    assert.deepEqual(
      fs.readFileSync(second.data.derivedArtifactPath),
      fs.readFileSync(first.data.derivedArtifactPath),
    );

    const module = await import(`${pathToFileURL(path.join(firstRequest.configuration.derivedDirectory, provider.entrypoint)).href}?test=${provider.backendId}`);
    const background = [];
    const nativeContext = {
      request: new Request("https://conformance.invalid/context"),
      env: { TEST_VALUE: "portable-value" },
      waitUntil(promise) {
        background.push(Promise.resolve(promise));
      },
    };
    const response = await provider.invoke(module, nativeContext);
    assert.deepEqual(await response.json(), {
      contextKeys: ["env", "params", "request", "waitUntil"],
      environment: "portable-value",
      parameter: "edge-canon-param",
    });
    await Promise.all(background);
  });
}

test("prepare rejects a canonical artifact changed after its manifest was made", async (context) => {
  const { root, canonical } = makeRoot(context);
  fs.appendFileSync(path.join(root, "canonical", "fixture.mjs"), "\n// tampered\n");
  const provider = providers[0];
  await assert.rejects(
    runAdapter({ manifestPath: manifestPath(provider), request: prepareRequest(root, canonical, provider), hostEnvironment: {} }),
    (error) => error instanceof ProviderArtifactError && error.code === "EC_ADAPTER_ARTIFACT_INVALID",
  );
});

test("prepare rejects undeclared canonical files and symbolic links", async (context) => {
  const { root, canonical } = makeRoot(context);
  fs.writeFileSync(path.join(root, "canonical", "extra.mjs"), "export default 1;\n");
  const provider = providers[0];
  await assert.rejects(
    runAdapter({ manifestPath: manifestPath(provider), request: prepareRequest(root, canonical, provider), hostEnvironment: {} }),
    (error) => error instanceof ProviderArtifactError && error.code === "EC_ADAPTER_ARTIFACT_INVALID",
  );
  fs.rmSync(path.join(root, "canonical", "extra.mjs"));
  fs.symlinkSync("fixture.mjs", path.join(root, "canonical", "extra.mjs"));
  await assert.rejects(
    runAdapter({ manifestPath: manifestPath(provider), request: prepareRequest(root, canonical, provider, "symlink"), hostEnvironment: {} }),
    (error) => error instanceof ProviderArtifactError && error.code === "EC_ADAPTER_ARTIFACT_INVALID",
  );
});

test("prepare never overwrites a conflicting derived artifact", async (context) => {
  const { root, canonical } = makeRoot(context);
  const provider = providers[0];
  const request = prepareRequest(root, canonical, provider);
  await runAdapter({ manifestPath: manifestPath(provider), request, hostEnvironment: {} });
  const entrypoint = path.join(request.configuration.derivedDirectory, provider.entrypoint);
  fs.appendFileSync(entrypoint, "\n// conflict\n");
  await assert.rejects(
    runAdapter({ manifestPath: manifestPath(provider), request, hostEnvironment: {} }),
    (error) => error instanceof ProviderArtifactError && error.code === "EC_ADAPTER_ARTIFACT_CONFLICT",
  );
  assert.match(fs.readFileSync(entrypoint, "utf8"), /conflict/);
});

test("prepare rejects missing or unsafe configuration before writing", async (context) => {
  const { root, canonical } = makeRoot(context);
  const provider = providers[0];
  const missing = prepareRequest(root, canonical, provider);
  delete missing.configuration.compatibilityDate;
  await assert.rejects(
    runAdapter({ manifestPath: manifestPath(provider), request: missing, hostEnvironment: {} }),
    (error) => error instanceof AdapterError && error.code === "EC_ADAPTER_CONFIGURATION_MISSING",
  );

  const escaping = prepareRequest(root, canonical, provider, "escape");
  escaping.configuration.derivedDirectory = path.join(root, "outside-work");
  await assert.rejects(
    runAdapter({ manifestPath: manifestPath(provider), request: escaping, hostEnvironment: {} }),
    (error) => error instanceof ProviderArtifactError && error.code === "EC_ADAPTER_CONFIGURATION_INVALID",
  );
  assert.equal(fs.existsSync(escaping.configuration.derivedDirectory), false);

  const evidenceOverlap = prepareRequest(root, canonical, provider, "evidence-overlap");
  evidenceOverlap.configuration.derivedDirectory = path.join(evidenceOverlap.evidenceDirectory, "derived");
  await assert.rejects(
    runAdapter({ manifestPath: manifestPath(provider), request: evidenceOverlap, hostEnvironment: {} }),
    (error) => error instanceof ProviderArtifactError && error.code === "EC_ADAPTER_CONFIGURATION_INVALID",
  );

  const canonicalOverlap = prepareRequest(root, canonical, provider, "canonical-overlap");
  canonicalOverlap.configuration.derivedDirectory = path.join(root, "canonical", "derived");
  await assert.rejects(
    runAdapter({ manifestPath: manifestPath(provider), request: canonicalOverlap, hostEnvironment: {} }),
    (error) => error instanceof ProviderArtifactError && error.code === "EC_ADAPTER_CONFIGURATION_INVALID",
  );
});
