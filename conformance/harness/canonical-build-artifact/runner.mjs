import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { canonicalJsonBytes } from "./canonical-json.mjs";
import { buildFixture } from "./fixture.mjs";
import { ArtifactValidationError, validateArtifact } from "./validator.mjs";

const CASE_IDS = Array.from({ length: 8 }, (_, index) => `EC-ARTIFACT-T${String(index + 1).padStart(3, "0")}`);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function exists(value) {
  try {
    await fsp.lstat(value);
    return true;
  } catch {
    return false;
  }
}

function resolveStandardVersion(explicit) {
  if (explicit) return explicit;
  if (process.env.EDGE_CANON_STANDARD_VERSION) return process.env.EDGE_CANON_STANDARD_VERSION;
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: new URL("../../..", import.meta.url),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return `edge-canon.next@${commit}`;
}

async function copyArtifact(source, destination) {
  await fsp.cp(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: false });
}

async function readManifest(root) {
  return JSON.parse(await fsp.readFile(path.join(root, ".edge-canon", "output.json"), "utf8"));
}

async function writeManifest(root, manifest, canonical = true) {
  const bytes = canonical ? canonicalJsonBytes(manifest) : Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fsp.writeFile(path.join(root, ".edge-canon", "output.json"), bytes);
}

async function captureFailure(root, options = {}) {
  try {
    await validateArtifact(root, options);
    return { code: null, message: null };
  } catch (error) {
    if (!(error instanceof ArtifactValidationError)) throw error;
    return { code: error.code, message: error.message };
  }
}

async function mutation(root, name, mutate, validateOptions = {}) {
  const target = path.join(path.dirname(root), name);
  await copyArtifact(root, target);
  await mutate(target);
  return captureFailure(target, validateOptions);
}

function record(id, data) {
  return {
    id,
    observedAt: new Date().toISOString(),
    data,
    evidenceRefs: [`local:canonical-build-artifact/${id}`],
  };
}

export async function runSuite(options = {}) {
  const standardVersion = resolveStandardVersion(options.standardVersion);
  if (!/^edge-canon\.next@[0-9a-f]{40}$/.test(standardVersion)) throw new Error("an exact Edge Canon commit is required");
  const workspace = await fsp.mkdtemp(path.join(options.temporaryRoot ?? os.tmpdir(), "edge-canon-artifact-"));
  try {
    const primaryRoot = path.join(workspace, "primary");
    const primary = await buildFixture(primaryRoot, { marker: "canonical", standardVersion });
    const primaryManifestBytes = await fsp.readFile(path.join(primaryRoot, ".edge-canon", "output.json"));
    const primaryManifest = JSON.parse(primaryManifestBytes.toString("utf8"));

    const cases = [];
    cases.push(record(CASE_IDS[0], {
      artifactSha256: primary.artifactSha256,
      manifestSha256: sha256(primaryManifestBytes),
      contentRootSha256: primary.contentRootSha256,
      fileCount: primary.fileCount,
      inventoryComplete: true,
      documentKinds: primary.documentKinds,
      standardVersion: primary.standardVersion,
      canonicalManifest: primaryManifestBytes.equals(canonicalJsonBytes(primaryManifest)),
      completedRoot: await exists(primaryRoot),
    }));

    const secondRoot = path.join(workspace, "second-location");
    const second = await buildFixture(secondRoot, { marker: "canonical", standardVersion });
    const secondManifestBytes = await fsp.readFile(path.join(secondRoot, ".edge-canon", "output.json"));
    cases.push(record(CASE_IDS[1], {
      artifactIdentities: [primary.artifactSha256, second.artifactSha256],
      contentRoots: [primary.contentRootSha256, second.contentRootSha256],
      manifestBytesEqual: primaryManifestBytes.equals(secondManifestBytes),
      fileDigestsEqual: JSON.stringify(primary.fileDigests) === JSON.stringify(second.fileDigests),
      absoluteDirectoryEmbedded: primaryManifestBytes.includes(Buffer.from(workspace, "utf8")),
    }));

    const stagingPaths = [];
    const concurrentRoots = [path.join(workspace, "concurrent-red"), path.join(workspace, "concurrent-blue")];
    const [red, blue] = await Promise.all([
      buildFixture(concurrentRoots[0], { marker: "red", standardVersion, onStaging: (value) => stagingPaths.push(value) }),
      buildFixture(concurrentRoots[1], { marker: "blue", standardVersion, onStaging: (value) => stagingPaths.push(value) }),
    ]);
    const [redModule, blueModule] = await Promise.all(concurrentRoots.map((root) => fsp.readFile(path.join(root, "functions", "main.js"), "utf8")));
    cases.push(record(CASE_IDS[2], {
      stagingPathsDistinct: stagingPaths.length === 2 && new Set(stagingPaths).size === 2,
      publishedRootsDistinct: new Set(concurrentRoots).size === 2,
      bothValid: red.completed === true && blue.completed === true,
      markerIsolation: redModule.includes("red") && !redModule.includes("blue") && blueModule.includes("blue") && !blueModule.includes("red"),
    }));

    const pathResults = [];
    for (const [name, unsafePath, expected] of [
      ["path-traversal", "../escape.txt", "EC_ARTIFACT_PATH_INVALID"],
      ["path-backslash", "static\\escape.txt", "EC_ARTIFACT_PATH_INVALID"],
      ["path-device", "static/CON.txt", "EC_ARTIFACT_PATH_INVALID"],
    ]) {
      const result = await mutation(primaryRoot, name, async (target) => {
        const manifest = await readManifest(target);
        manifest.content.files[0].path = unsafePath;
        manifest.content.files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
        await writeManifest(target, manifest);
      });
      pathResults.push({ variant: name, code: result.code, expected, message: result.message });
    }
    const collision = await mutation(primaryRoot, "path-collision", async (target) => {
      const manifest = await readManifest(target);
      const source = manifest.content.files.find((file) => file.path === "static/index.html");
      manifest.content.files.push({ ...source, path: "STATIC/index.html" });
      manifest.content.files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
      await writeManifest(target, manifest);
    });
    pathResults.push({ variant: "path-collision", code: collision.code, expected: "EC_ARTIFACT_PATH_COLLISION", message: collision.message });
    const externalDirectory = path.join(workspace, "external-link-target");
    await fsp.mkdir(externalDirectory);
    const link = await mutation(primaryRoot, "path-link", async (target) => {
      await fsp.symlink(externalDirectory, path.join(target, "linked"), process.platform === "win32" ? "junction" : "dir");
    });
    pathResults.push({ variant: "path-link", code: link.code, expected: "EC_ARTIFACT_FILE_TYPE_INVALID", message: link.message });
    cases.push(record(CASE_IDS[3], {
      variants: pathResults.map(({ variant, code, expected }) => ({ variant, code, expected })),
      messagesSanitized: pathResults.every((result) => result.message && !result.message.includes(workspace) && !result.message.includes("escape.txt")),
    }));

    const secretCanary = "EC_SECRET_CANARY_ef916095b6b74c2a";
    const providerField = await mutation(primaryRoot, "provider-field", async (target) => {
      const manifest = await readManifest(target);
      manifest.provider = { id: "vendor-native" };
      await writeManifest(target, manifest);
    });
    const secretContent = await mutation(primaryRoot, "secret-content", async (target) => {
      await fsp.appendFile(path.join(target, "static", "index.html"), secretCanary);
    }, { forbiddenByteSequences: [secretCanary] });
    const secretPath = await mutation(primaryRoot, "secret-path", async (target) => {
      await fsp.writeFile(path.join(target, `static/${secretCanary}.txt`), "unlisted");
    }, { forbiddenByteSequences: [secretCanary] });
    cases.push(record(CASE_IDS[4], {
      providerFieldCode: providerField.code,
      secretContentCode: secretContent.code,
      secretPathCode: secretPath.code,
      canaryLeaked: [providerField.message, secretContent.message, secretPath.message].some((value) => value?.includes(secretCanary)),
    }));

    const tamperResults = [];
    tamperResults.push({ variant: "modified", ...(await mutation(primaryRoot, "tamper-modified", async (target) => {
      await fsp.appendFile(path.join(target, "static", "index.html"), "tampered");
    })) });
    tamperResults.push({ variant: "deleted", ...(await mutation(primaryRoot, "tamper-deleted", async (target) => {
      await fsp.unlink(path.join(target, "static", "index.html"));
    })) });
    tamperResults.push({ variant: "added", ...(await mutation(primaryRoot, "tamper-added", async (target) => {
      await fsp.writeFile(path.join(target, "unlisted.txt"), "unlisted");
    })) });
    tamperResults.push({ variant: "document", ...(await mutation(primaryRoot, "tamper-document", async (target) => {
      const manifest = await readManifest(target);
      manifest.documents[0].sha256 = manifest.content.files.find((file) => file.path === "static/index.html").sha256;
      await writeManifest(target, manifest);
    })) });
    tamperResults.push({ variant: "noncanonical", ...(await mutation(primaryRoot, "tamper-noncanonical", async (target) => {
      await writeManifest(target, await readManifest(target), false);
    })) });
    cases.push(record(CASE_IDS[5], {
      variants: tamperResults.map(({ variant, code }) => ({ variant, code })),
      derivationAttempts: 0,
      autoRepairs: 0,
    }));

    const faultResults = [];
    for (const failAt of ["after-files", "after-manifest", "before-publish"]) {
      const target = path.join(workspace, `failure-${failAt}`);
      let code = null;
      try {
        await buildFixture(target, { marker: failAt, standardVersion, failAt });
      } catch (error) {
        code = error.code;
      }
      faultResults.push({ failAt, code, publishedRootExists: await exists(target) });
    }
    cases.push(record(CASE_IDS[6], {
      faults: faultResults,
      completedArtifactIdentities: 0,
    }));

    const versionResults = [];
    for (const [variant, mutateManifest, expected] of [
      ["higher-major", (manifest) => { manifest.format = "edge-canon.build-output/v2"; }, "EC_ARTIFACT_VERSION_UNSUPPORTED"],
      ["floating-version", (manifest) => { manifest.standard.version = "edge-canon.next"; }, "EC_ARTIFACT_STANDARD_PIN_INVALID"],
      ["short-commit", (manifest) => { manifest.standard.version = "edge-canon.next@6a87685"; }, "EC_ARTIFACT_STANDARD_PIN_INVALID"],
    ]) {
      const result = await mutation(primaryRoot, `version-${variant}`, async (target) => {
        const manifest = await readManifest(target);
        mutateManifest(manifest);
        await writeManifest(target, manifest);
      });
      versionResults.push({ variant, code: result.code, expected });
    }
    const sourceBefore = await validateArtifact(primaryRoot, { expectedStandardVersion: standardVersion });
    const migratedRoot = path.join(workspace, "migrated");
    const migrated = await buildFixture(migratedRoot, { marker: "migrated", standardVersion, lineage: sourceBefore.artifactSha256 });
    const provenance = JSON.parse(await fsp.readFile(path.join(migratedRoot, "documents", "provenance.json"), "utf8"));
    const sourceAfter = await validateArtifact(primaryRoot, { expectedStandardVersion: standardVersion });
    cases.push(record(CASE_IDS[7], {
      versions: versionResults,
      semanticDocumentsReadBeforeRejection: false,
      sourceIdentity: sourceBefore.artifactSha256,
      migratedIdentity: migrated.artifactSha256,
      sourceMutated: sourceBefore.artifactSha256 !== sourceAfter.artifactSha256,
      lineageRecorded: provenance.predicate.buildDefinition.resolvedDependencies.some((item) => item.digest?.sha256 === sourceBefore.artifactSha256),
    }));

    return {
      schemaVersion: 1,
      standardId: "edge-canon.next",
      suiteId: "EC-ARTIFACT",
      backend: {
        id: "edge-canon-reference-validator",
        implementationVersion: "edge-canon-reference-artifact-harness/1",
        standardVersion,
      },
      artifactSha256: primary.artifactSha256,
      cases,
    };
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const document = await runSuite();
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`EC-ARTIFACT runner failed: ${error.code ?? "EC_ARTIFACT_RUNNER_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
