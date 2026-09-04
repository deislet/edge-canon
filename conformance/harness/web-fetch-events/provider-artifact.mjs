import fs from "node:fs";
import path from "node:path";

import { serializeArtifactManifest, sha256 } from "./canonical-artifact.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const PROJECT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EXPECTED_CANONICAL_FILES = ["cpu-workload.mjs", "fixture.mjs"];
const DERIVED_MANIFEST = "edge-canon-derived-artifact.json";

export class ProviderArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderArtifactError";
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (!condition) throw new ProviderArtifactError(code, message);
}

function comparePath(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys, label) {
  fail(value && typeof value === "object" && !Array.isArray(value), "EC_ADAPTER_ARTIFACT_INVALID", `${label} must be an object`);
  const actual = Object.keys(value).sort(comparePath);
  const expected = [...keys].sort(comparePath);
  fail(JSON.stringify(actual) === JSON.stringify(expected), "EC_ADAPTER_ARTIFACT_INVALID", `${label} keys differ`);
}

function safeRelative(relativePath, label) {
  fail(typeof relativePath === "string" && relativePath.length > 0, "EC_ADAPTER_ARTIFACT_INVALID", `${label} is empty`);
  fail(!relativePath.includes("\\") && !path.posix.isAbsolute(relativePath), "EC_ADAPTER_ARTIFACT_INVALID", `${label} is not a portable relative path`);
  const parts = relativePath.split("/");
  fail(parts.every((part) => part && part !== "." && part !== ".."), "EC_ADAPTER_ARTIFACT_INVALID", `${label} contains an unsafe segment`);
  return parts;
}

function readJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ProviderArtifactError("EC_ADAPTER_ARTIFACT_INVALID", `${label} is not JSON: ${error.message}`);
  }
}

function requirePlainDirectory(directory, label) {
  const status = fs.lstatSync(directory, { throwIfNoEntry: false });
  fail(status?.isDirectory() && !status.isSymbolicLink(), "EC_ADAPTER_ARTIFACT_INVALID", `${label} is not a regular directory`);
  const resolved = path.resolve(directory);
  fail(fs.realpathSync(directory) === resolved, "EC_ADAPTER_ARTIFACT_INVALID", `${label} traverses a symbolic link`);
  return resolved;
}

function containsOrEquals(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return containsOrEquals(left, right) || containsOrEquals(right, left);
}

function collectTree(root, relative = "") {
  const directory = relative ? path.join(root, ...relative.split("/")) : root;
  const names = fs.readdirSync(directory).sort(comparePath);
  const files = [];
  for (const name of names) {
    const childRelative = relative ? `${relative}/${name}` : name;
    const child = path.join(root, ...childRelative.split("/"));
    const status = fs.lstatSync(child);
    fail(!status.isSymbolicLink(), "EC_ADAPTER_ARTIFACT_INVALID", `artifact contains symbolic link ${childRelative}`);
    if (status.isDirectory()) files.push(...collectTree(root, childRelative));
    else {
      fail(status.isFile(), "EC_ADAPTER_ARTIFACT_INVALID", `artifact contains non-file ${childRelative}`);
      files.push(childRelative);
    }
  }
  return files;
}

function validateFileEntries(root, entries, manifestName) {
  fail(Array.isArray(entries) && entries.length > 0, "EC_ADAPTER_ARTIFACT_INVALID", "artifact files must be a non-empty array");
  const names = [];
  const contents = new Map();
  for (const [index, entry] of entries.entries()) {
    exactKeys(entry, ["path", "size", "sha256"], `files[${index}]`);
    const parts = safeRelative(entry.path, `files[${index}].path`);
    fail(Number.isSafeInteger(entry.size) && entry.size >= 0, "EC_ADAPTER_ARTIFACT_INVALID", `${entry.path} size is invalid`);
    fail(typeof entry.sha256 === "string" && SHA256.test(entry.sha256), "EC_ADAPTER_ARTIFACT_INVALID", `${entry.path} digest is invalid`);
    fail(!names.includes(entry.path), "EC_ADAPTER_ARTIFACT_INVALID", `duplicate artifact file ${entry.path}`);
    const filePath = path.join(root, ...parts);
    const status = fs.lstatSync(filePath, { throwIfNoEntry: false });
    fail(status?.isFile() && !status.isSymbolicLink(), "EC_ADAPTER_ARTIFACT_INVALID", `${entry.path} is not a regular file`);
    const bytes = fs.readFileSync(filePath);
    fail(bytes.byteLength === entry.size, "EC_ADAPTER_ARTIFACT_INVALID", `${entry.path} size differs`);
    fail(sha256(bytes) === entry.sha256, "EC_ADAPTER_ARTIFACT_INVALID", `${entry.path} digest differs`);
    names.push(entry.path);
    contents.set(entry.path, bytes);
  }
  fail(JSON.stringify(names) === JSON.stringify([...names].sort(comparePath)), "EC_ADAPTER_ARTIFACT_INVALID", "artifact files are not in canonical order");
  const actual = collectTree(root).filter((name) => name !== manifestName);
  fail(JSON.stringify(actual) === JSON.stringify(names), "EC_ADAPTER_ARTIFACT_INVALID", "artifact tree differs from its manifest");
  return contents;
}

export function validateCanonicalArtifact(request) {
  const manifestPath = request.canonicalArtifact.path;
  const manifestStatus = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  fail(manifestStatus?.isFile() && !manifestStatus.isSymbolicLink(), "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact manifest is not a regular file");
  fail(path.basename(manifestPath) === "edge-canon-canonical-artifact.json", "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact manifest name differs");
  fail(fs.realpathSync(manifestPath) === path.resolve(manifestPath), "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact path traverses a symbolic link");
  const bytes = fs.readFileSync(manifestPath);
  fail(sha256(bytes) === request.canonicalArtifact.sha256, "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact manifest digest differs");
  const manifest = readJson(bytes, "canonical artifact manifest");
  exactKeys(manifest, ["schemaVersion", "artifactFormat", "standardVersion", "suiteId", "entrypoint", "files"], "canonical artifact manifest");
  fail(manifest.schemaVersion === 1, "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact schemaVersion differs");
  fail(manifest.artifactFormat === "edge-canon.canonical-artifact/v1", "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact format differs");
  fail(manifest.standardVersion === request.standardVersion, "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact standardVersion differs");
  fail(manifest.suiteId === request.suiteId, "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact suiteId differs");
  fail(manifest.entrypoint === "fixture.mjs", "EC_ADAPTER_ARTIFACT_INVALID", "canonical artifact entrypoint differs");
  const root = requirePlainDirectory(path.dirname(manifestPath), "canonical artifact directory");
  const contents = validateFileEntries(root, manifest.files, path.basename(manifestPath));
  fail(
    JSON.stringify([...contents.keys()]) === JSON.stringify(EXPECTED_CANONICAL_FILES),
    "EC_ADAPTER_ARTIFACT_INVALID",
    "canonical artifact file set differs from EC-WEB v1",
  );
  return { manifest, contents, root };
}

function jsonFile(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function wrapperPrelude(backendId) {
  return `import handler from "../canonical/fixture.mjs";

const EVIDENCE = Object.freeze({
  record(marker) {
    console.log("EDGE_CANON_EVIDENCE " + JSON.stringify({
      schemaVersion: 1,
      backendId: "${backendId}",
      event: "record",
      marker: String(marker),
    }));
    return Promise.resolve();
  },
});

function standardContext(request, nativeEnvironment, nativeWaitUntil) {
  if (typeof nativeWaitUntil !== "function") {
    throw new TypeError("provider context does not expose waitUntil");
  }
  const env = Object.assign({}, nativeEnvironment ?? {});
  Object.defineProperty(env, "EVIDENCE", {
    value: EVIDENCE,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return {
    request,
    env,
    params: { name: "edge-canon-param" },
    waitUntil(promise) {
      return nativeWaitUntil(promise);
    },
  };
}

`;
}

function providerFiles(backendId, canonical, { projectName, compatibilityDate }) {
  const files = new Map([
    ["canonical/cpu-workload.mjs", canonical.contents.get("cpu-workload.mjs")],
    ["canonical/fixture.mjs", canonical.contents.get("fixture.mjs")],
  ]);
  if (backendId === "cloudflare-workers-pages") {
    files.set("src/index.mjs", Buffer.from(`${wrapperPrelude(backendId)}export default {
  fetch(request, env, executionContext) {
    return handler(standardContext(request, env, executionContext.waitUntil.bind(executionContext)));
  },
};
`, "utf8"));
    files.set("wrangler.json", jsonFile({
      $schema: "node_modules/wrangler/config-schema.json",
      name: projectName,
      main: "src/index.mjs",
      compatibility_date: compatibilityDate,
      workers_dev: true,
    }));
    return { entrypoint: "src/index.mjs", files };
  }
  if (backendId === "tencent-edgeone-makers") {
    files.set("edge-functions/[[default]].js", Buffer.from(`${wrapperPrelude(backendId)}export default function onRequest(context) {
  return handler(standardContext(
    context.request,
    context.env,
    context.waitUntil.bind(context),
  ));
}
`, "utf8"));
    files.set("edgeone.json", jsonFile({ name: projectName }));
    files.set("package.json", jsonFile({
      name: projectName,
      version: "0.0.0",
      private: true,
      type: "module",
    }));
    return { entrypoint: "edge-functions/[[default]].js", files };
  }
  if (backendId === "deislet") {
    files.set("functions/[[all]].js", Buffer.from(`${wrapperPrelude(backendId)}export default function onRequest(context) {
  return handler(standardContext(
    context.request,
    context.env,
    context.waitUntil.bind(context),
  ));
}
`, "utf8"));
    files.set(".config.json", jsonFile({
      version: "1.0.0",
      name: projectName,
      runtime: "standard-v1",
      language: "javascript",
      functionRoot: "./functions",
      compatibilityDate,
      vendors: { deislet: { enabled: true } },
      build: { outDir: "./dist" },
    }));
    files.set("package.json", jsonFile({
      name: projectName,
      version: "0.0.0",
      private: true,
      type: "module",
    }));
    return { entrypoint: "functions/[[all]].js", files };
  }
  throw new ProviderArtifactError("EC_ADAPTER_ARTIFACT_INVALID", `unsupported backend ${backendId}`);
}

function validateCompatibilityDate(value) {
  fail(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value), "EC_ADAPTER_CONFIGURATION_INVALID", "compatibilityDate must be YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00Z`);
  fail(!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value, "EC_ADAPTER_CONFIGURATION_INVALID", "compatibilityDate is not a calendar date");
}

function validatePrepareConfiguration(request) {
  const configuration = request.configuration;
  fail(PROJECT_NAME.test(configuration.projectName), "EC_ADAPTER_CONFIGURATION_INVALID", "projectName must be a portable lowercase DNS label");
  validateCompatibilityDate(configuration.compatibilityDate);
  fail(typeof configuration.derivedDirectory === "string" && path.isAbsolute(configuration.derivedDirectory), "EC_ADAPTER_CONFIGURATION_INVALID", "derivedDirectory must be absolute");
  fail(path.resolve(configuration.derivedDirectory) === configuration.derivedDirectory, "EC_ADAPTER_CONFIGURATION_INVALID", "derivedDirectory must be normalized");
  const work = requirePlainDirectory(request.workDirectory, "workDirectory");
  const evidence = requirePlainDirectory(request.evidenceDirectory, "evidenceDirectory");
  const relative = path.relative(work, configuration.derivedDirectory);
  fail(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "EC_ADAPTER_CONFIGURATION_INVALID", "derivedDirectory must be a strict descendant of workDirectory");
  const parent = requirePlainDirectory(path.dirname(configuration.derivedDirectory), "derivedDirectory parent");
  const parentRelative = path.relative(work, parent);
  fail(parentRelative !== ".." && !parentRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(parentRelative), "EC_ADAPTER_CONFIGURATION_INVALID", "derivedDirectory parent escapes workDirectory");
  fail(!pathsOverlap(configuration.derivedDirectory, evidence), "EC_ADAPTER_CONFIGURATION_INVALID", "derivedDirectory and evidenceDirectory must not overlap");
  return configuration;
}

function buildExpected(request, manifest, canonical, configuration) {
  const generated = providerFiles(manifest.backendId, canonical, configuration);
  const files = [...generated.files.entries()]
    .map(([relativePath, bytes]) => ({ path: relativePath, size: bytes.byteLength, sha256: sha256(bytes) }))
    .sort((left, right) => comparePath(left.path, right.path));
  const derivedManifest = {
    schemaVersion: 1,
    artifactFormat: "edge-canon.provider-derived-artifact/v1",
    standardVersion: request.standardVersion,
    suiteId: request.suiteId,
    backendId: manifest.backendId,
    canonicalArtifactSha256: request.canonicalArtifact.sha256,
    inputs: {
      projectName: configuration.projectName,
      compatibilityDate: configuration.compatibilityDate,
    },
    entrypoint: generated.entrypoint,
    files,
  };
  return { ...generated, manifest: derivedManifest, manifestBytes: serializeArtifactManifest(derivedManifest) };
}

function writeTree(root, expected) {
  fs.chmodSync(root, 0o700);
  for (const [relativePath, bytes] of expected.files) {
    const target = path.join(root, ...safeRelative(relativePath, relativePath));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    fs.chmodSync(target, 0o600);
  }
  const manifestPath = path.join(root, DERIVED_MANIFEST);
  fs.writeFileSync(manifestPath, expected.manifestBytes, { flag: "wx", mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);
}

function validateExisting(root, expected) {
  requirePlainDirectory(root, "derivedDirectory");
  const actualTree = collectTree(root);
  const expectedTree = [...expected.files.keys(), DERIVED_MANIFEST].sort(comparePath);
  fail(JSON.stringify(actualTree) === JSON.stringify(expectedTree), "EC_ADAPTER_ARTIFACT_CONFLICT", "existing derived artifact tree differs");
  const actualManifest = fs.readFileSync(path.join(root, DERIVED_MANIFEST));
  fail(actualManifest.equals(expected.manifestBytes), "EC_ADAPTER_ARTIFACT_CONFLICT", "existing derived artifact manifest differs");
  for (const [relativePath, bytes] of expected.files) {
    const actual = fs.readFileSync(path.join(root, ...relativePath.split("/")));
    fail(actual.equals(bytes), "EC_ADAPTER_ARTIFACT_CONFLICT", `existing derived file ${relativePath} differs`);
  }
}

export function prepareProviderArtifact({ request, manifest }) {
  const configuration = validatePrepareConfiguration(request);
  const canonical = validateCanonicalArtifact(request);
  fail(
    !pathsOverlap(configuration.derivedDirectory, canonical.root),
    "EC_ADAPTER_CONFIGURATION_INVALID",
    "derivedDirectory and canonical artifact directory must not overlap",
  );
  const expected = buildExpected(request, manifest, canonical, configuration);
  let idempotent = false;
  if (fs.existsSync(configuration.derivedDirectory)) {
    validateExisting(configuration.derivedDirectory, expected);
    idempotent = true;
  } else {
    const parent = path.dirname(configuration.derivedDirectory);
    const staged = fs.mkdtempSync(path.join(parent, ".edge-canon-derived-"));
    try {
      writeTree(staged, expected);
      fs.renameSync(staged, configuration.derivedDirectory);
    } catch (error) {
      fs.rmSync(staged, { recursive: true, force: true });
      if (fs.existsSync(configuration.derivedDirectory)) {
        validateExisting(configuration.derivedDirectory, expected);
        idempotent = true;
      } else {
        throw error;
      }
    }
  }
  return {
    canonicalArtifactSha256: request.canonicalArtifact.sha256,
    derivedArtifactPath: path.join(configuration.derivedDirectory, DERIVED_MANIFEST),
    derivedArtifactSha256: sha256(expected.manifestBytes),
    entrypoint: expected.entrypoint,
    idempotent,
  };
}
