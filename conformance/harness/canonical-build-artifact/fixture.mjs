import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJsonBytes } from "./canonical-json.mjs";
import { fileSetSha256, validateArtifact } from "./validator.mjs";

const MEDIA_TYPES = new Map([
  ["documents/provenance.json", "application/vnd.in-toto+json"],
  ["documents/runtime-entrypoints.json", "application/json"],
  ["documents/sbom.spdx.json", "application/spdx+json"],
  ["documents/validation-report.json", "application/json"],
  ["functions/main.js", "text/javascript; charset=utf-8"],
  ["static/index.html", "text/html; charset=utf-8"],
]);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function json(value) {
  return canonicalJsonBytes(value);
}

function inputDigest(label, marker) {
  return sha256(Buffer.from(`edge-canon-fixture\0${label}\0${marker}`, "utf8"));
}

async function exists(value) {
  try {
    await fsp.lstat(value);
    return true;
  } catch {
    return false;
  }
}

export async function buildFixture(root, options = {}) {
  const marker = options.marker ?? "canonical";
  const standardVersion = options.standardVersion;
  if (!/^edge-canon\.next@[0-9a-f]{40}$/.test(standardVersion ?? "")) {
    const error = new Error("fixture requires an exact standard version");
    error.code = "EC_ARTIFACT_FIXTURE_INPUT_INVALID";
    throw error;
  }
  if (await exists(root)) {
    const error = new Error("fixture output target already exists");
    error.code = "EC_ARTIFACT_TARGET_EXISTS";
    throw error;
  }
  const staging = `${root}.staging-${process.pid}-${randomUUID()}`;
  options.onStaging?.(staging);
  await fsp.mkdir(staging, { recursive: true });
  try {
    const provenance = {
      _type: "https://in-toto.io/Statement/v1",
      predicateType: "https://slsa.dev/provenance/v1",
      subject: [],
      predicate: {
        buildDefinition: {
          buildType: "https://github.com/deislet/edge-canon/build-types/reference-fixture/v1",
          externalParameters: { marker },
          internalParameters: {},
          resolvedDependencies: [],
        },
        runDetails: {
          builder: { id: "https://github.com/deislet/edge-canon/reference-builder/v1" },
          metadata: { invocationId: inputDigest("invocation", marker) },
        },
      },
    };
    if (options.lineage) provenance.predicate.buildDefinition.resolvedDependencies.push({ uri: "edge-canon:artifact", digest: { sha256: options.lineage } });
    const fileValues = new Map([
      ["documents/provenance.json", json(provenance)],
      ["documents/runtime-entrypoints.json", json({ schemaVersion: 1, entries: [{ id: "main", kind: "fetch", module: "functions/main.js", export: "default" }] })],
      ["documents/sbom.spdx.json", json({ spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT", name: `edge-canon-${marker}`, documentNamespace: `https://github.com/deislet/edge-canon/sbom/${inputDigest("sbom", marker)}`, creationInfo: { created: "2026-01-01T00:00:00Z", creators: ["Tool: edge-canon-reference-builder-1"] }, packages: [] })],
      ["documents/validation-report.json", json({ schemaVersion: 1, standardVersion, result: "pass", requirementsDigest: inputDigest("requirements", marker) })],
      ["functions/main.js", Buffer.from(`export default () => new Response(${JSON.stringify(marker)});\n`, "utf8")],
      ["static/index.html", Buffer.from(`<!doctype html><title>${marker}</title>\n`, "utf8")],
    ]);

    for (const [relative, bytes] of fileValues) {
      const absolute = path.join(staging, ...relative.split("/"));
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, bytes, { flag: "wx", mode: 0o644 });
    }
    if (options.failAt === "after-files") throw Object.assign(new Error("injected fixture failure"), { code: "EC_ARTIFACT_BUILD_FAILED" });

    const files = [...fileValues.entries()].map(([relative, bytes]) => ({
      path: relative,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      mediaType: MEDIA_TYPES.get(relative),
    })).sort((left, right) => compareUtf8(left.path, right.path));
    const kindByPath = new Map([
      ["documents/provenance.json", "provenance"],
      ["documents/runtime-entrypoints.json", "runtime-entrypoints"],
      ["documents/sbom.spdx.json", "sbom"],
      ["documents/validation-report.json", "validation-report"],
    ]);
    const documents = files.filter((file) => kindByPath.has(file.path)).map((file) => ({
      kind: kindByPath.get(file.path),
      schemaVersion: 1,
      path: file.path,
      sha256: file.sha256,
    })).sort((left, right) => compareUtf8(`${left.kind}\0${left.path}`, `${right.kind}\0${right.path}`));
    const builderBytes = await fsp.readFile(new URL("./fixture.mjs", import.meta.url));
    const manifest = {
      $schema: "https://github.com/deislet/edge-canon/schemas/canonical-build-output.schema.json",
      schemaVersion: 1,
      format: "edge-canon.build-output/v1",
      standard: { id: "edge-canon.next", version: standardVersion },
      content: { algorithm: "edge-canon.file-set-sha256/v1", rootSha256: fileSetSha256(files), files },
      documents,
      build: {
        sourceTreeSha256: inputDigest("source", marker),
        buildPlanSha256: inputDigest("plan", marker),
        dependencyLockSha256: inputDigest("lock", marker),
        publicInputsSha256: inputDigest("public", marker),
        sourceDateEpoch: 1767225600,
        networkAccess: "denied",
        secretInputsUsed: false,
        toolchains: [{ name: "edge-canon.reference-builder", version: "1", executableSha256: sha256(builderBytes) }],
      },
    };
    await fsp.mkdir(path.join(staging, ".edge-canon"), { recursive: true });
    await fsp.writeFile(path.join(staging, ".edge-canon", "output.json"), canonicalJsonBytes(manifest), { flag: "wx", mode: 0o644 });
    if (options.failAt === "after-manifest") throw Object.assign(new Error("injected fixture failure"), { code: "EC_ARTIFACT_BUILD_FAILED" });
    await validateArtifact(staging, { expectedStandardVersion: standardVersion });
    if (options.failAt === "before-publish") throw Object.assign(new Error("injected fixture failure"), { code: "EC_ARTIFACT_BUILD_FAILED" });
    await fsp.rename(staging, root);
    return { ...(await validateArtifact(root, { expectedStandardVersion: standardVersion })), root };
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
