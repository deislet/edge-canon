import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBytes } from "./canonical-json.mjs";

const MANIFEST_PATH = ".edge-canon/output.json";
const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_STANDARD_VERSION = /^edge-canon\.next@[0-9a-f]{40}$/;
const WINDOWS_DEVICES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const REQUIRED_DOCUMENTS = ["provenance", "runtime-entrypoints", "sbom", "validation-report"];

export class ArtifactValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArtifactValidationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ArtifactValidationError(code, message);
}

function requireValue(condition, code, message) {
  if (!condition) fail(code, message);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  requireValue(isObject(value), "EC_ARTIFACT_MANIFEST_INVALID", "manifest object is invalid");
  const allowed = new Set([...required, ...optional]);
  requireValue(
    required.every((key) => Object.hasOwn(value, key))
      && Object.keys(value).every((key) => allowed.has(key)),
    "EC_ARTIFACT_MANIFEST_INVALID",
    "manifest fields are invalid",
  );
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function u64(value) {
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
}

export function fileSetSha256(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const pathBytes = Buffer.from(file.path, "utf8");
    hash.update(u64(pathBytes.byteLength));
    hash.update(pathBytes);
    hash.update(u64(file.size));
    hash.update(Buffer.from(file.sha256, "hex"));
  }
  return hash.digest("hex");
}

function portablePath(value) {
  requireValue(typeof value === "string" && value.length > 0, "EC_ARTIFACT_PATH_INVALID", "artifact path is invalid");
  requireValue(Buffer.byteLength(value, "utf8") <= 1024, "EC_ARTIFACT_PATH_INVALID", "artifact path is invalid");
  requireValue(value === value.normalize("NFC"), "EC_ARTIFACT_PATH_INVALID", "artifact path is invalid");
  requireValue(!value.startsWith("/") && !value.includes("\\"), "EC_ARTIFACT_PATH_INVALID", "artifact path is invalid");
  requireValue(!/[\u0000-\u001f\u007f]/u.test(value), "EC_ARTIFACT_PATH_INVALID", "artifact path is invalid");
  const segments = value.split("/");
  requireValue(segments.every((segment) => segment && segment !== "." && segment !== ".."), "EC_ARTIFACT_PATH_INVALID", "artifact path is invalid");
  for (const segment of segments) {
    requireValue(!/[:*?"<>|]/u.test(segment), "EC_ARTIFACT_PATH_INVALID", "artifact path is invalid");
    requireValue(!/[. ]$/u.test(segment), "EC_ARTIFACT_PATH_INVALID", "artifact path is invalid");
    requireValue(!WINDOWS_DEVICES.test(segment), "EC_ARTIFACT_PATH_INVALID", "artifact path is invalid");
  }
  requireValue(value !== MANIFEST_PATH, "EC_ARTIFACT_PATH_INVALID", "artifact path is reserved");
}

function assertNoPortableCollisions(paths) {
  const prefixes = new Map();
  for (const value of paths) {
    portablePath(value);
    const segments = value.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index + 1).join("/");
      const collisionKey = prefix.normalize("NFC").toUpperCase();
      const existing = prefixes.get(collisionKey);
      requireValue(existing === undefined || existing === prefix, "EC_ARTIFACT_PATH_COLLISION", "artifact paths collide on a supported platform");
      prefixes.set(collisionKey, prefix);
    }
  }
}

function validateManifestShape(manifest, expectedStandardVersion) {
  exactKeys(manifest, ["schemaVersion", "format", "standard", "content", "documents", "build"], ["$schema"]);
  requireValue(manifest.schemaVersion === 1, "EC_ARTIFACT_VERSION_UNSUPPORTED", "artifact schema version is unsupported");
  requireValue(manifest.format === "edge-canon.build-output/v1", "EC_ARTIFACT_VERSION_UNSUPPORTED", "artifact format is unsupported");

  exactKeys(manifest.standard, ["id", "version"]);
  requireValue(manifest.standard.id === "edge-canon.next", "EC_ARTIFACT_STANDARD_PIN_INVALID", "standard identifier is invalid");
  requireValue(EXACT_STANDARD_VERSION.test(manifest.standard.version), "EC_ARTIFACT_STANDARD_PIN_INVALID", "standard version must be exact");
  if (expectedStandardVersion !== undefined) {
    requireValue(manifest.standard.version === expectedStandardVersion, "EC_ARTIFACT_STANDARD_PIN_INVALID", "standard version differs from the required version");
  }

  exactKeys(manifest.content, ["algorithm", "rootSha256", "files"]);
  requireValue(manifest.content.algorithm === "edge-canon.file-set-sha256/v1", "EC_ARTIFACT_MANIFEST_INVALID", "content algorithm is invalid");
  requireValue(SHA256.test(manifest.content.rootSha256), "EC_ARTIFACT_MANIFEST_INVALID", "content root is invalid");
  requireValue(Array.isArray(manifest.content.files) && manifest.content.files.length > 0, "EC_ARTIFACT_MANIFEST_INVALID", "file inventory is invalid");

  const paths = [];
  for (const file of manifest.content.files) {
    exactKeys(file, ["path", "size", "sha256", "mediaType"]);
    portablePath(file.path);
    requireValue(Number.isSafeInteger(file.size) && file.size >= 0, "EC_ARTIFACT_MANIFEST_INVALID", "file size is invalid");
    requireValue(SHA256.test(file.sha256), "EC_ARTIFACT_MANIFEST_INVALID", "file digest is invalid");
    requireValue(typeof file.mediaType === "string" && file.mediaType.length > 0 && file.mediaType.length <= 256, "EC_ARTIFACT_MANIFEST_INVALID", "file media type is invalid");
    paths.push(file.path);
  }
  requireValue(new Set(paths).size === paths.length, "EC_ARTIFACT_FILE_SET_MISMATCH", "file inventory contains duplicates");
  requireValue(paths.every((value, index) => index === 0 || compareUtf8(paths[index - 1], value) < 0), "EC_ARTIFACT_MANIFEST_INVALID", "file inventory order is invalid");
  assertNoPortableCollisions(paths);

  requireValue(Array.isArray(manifest.documents) && manifest.documents.length >= 4, "EC_ARTIFACT_DOCUMENT_INVALID", "semantic document index is invalid");
  const fileByPath = new Map(manifest.content.files.map((file) => [file.path, file]));
  const documentKeys = new Set();
  const documentKinds = [];
  for (const document of manifest.documents) {
    exactKeys(document, ["kind", "schemaVersion", "path", "sha256"]);
    requireValue(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(document.kind), "EC_ARTIFACT_DOCUMENT_INVALID", "semantic document kind is invalid");
    requireValue(Number.isSafeInteger(document.schemaVersion) && document.schemaVersion >= 1, "EC_ARTIFACT_DOCUMENT_INVALID", "semantic document version is invalid");
    portablePath(document.path);
    requireValue(SHA256.test(document.sha256), "EC_ARTIFACT_DOCUMENT_INVALID", "semantic document digest is invalid");
    const file = fileByPath.get(document.path);
    requireValue(file && file.sha256 === document.sha256, "EC_ARTIFACT_DOCUMENT_INVALID", "semantic document is not bound to content");
    const key = `${document.kind}\0${document.path}`;
    requireValue(!documentKeys.has(key), "EC_ARTIFACT_DOCUMENT_INVALID", "semantic document index contains duplicates");
    documentKeys.add(key);
    documentKinds.push(document.kind);
  }
  requireValue(
    manifest.documents.every((value, index) => index === 0 || compareUtf8(`${manifest.documents[index - 1].kind}\0${manifest.documents[index - 1].path}`, `${value.kind}\0${value.path}`) < 0),
    "EC_ARTIFACT_DOCUMENT_INVALID",
    "semantic document order is invalid",
  );
  for (const kind of REQUIRED_DOCUMENTS) {
    requireValue(documentKinds.filter((value) => value === kind).length === 1, "EC_ARTIFACT_DOCUMENT_INVALID", "a required semantic document is missing or duplicated");
  }

  exactKeys(manifest.build, [
    "sourceTreeSha256", "buildPlanSha256", "dependencyLockSha256", "publicInputsSha256",
    "sourceDateEpoch", "networkAccess", "secretInputsUsed", "toolchains",
  ]);
  for (const key of ["sourceTreeSha256", "buildPlanSha256", "dependencyLockSha256", "publicInputsSha256"]) {
    requireValue(SHA256.test(manifest.build[key]), "EC_ARTIFACT_MANIFEST_INVALID", "build input digest is invalid");
  }
  requireValue(Number.isSafeInteger(manifest.build.sourceDateEpoch) && manifest.build.sourceDateEpoch >= 0, "EC_ARTIFACT_MANIFEST_INVALID", "source date epoch is invalid");
  requireValue(["denied", "declared"].includes(manifest.build.networkAccess), "EC_ARTIFACT_MANIFEST_INVALID", "network policy is invalid");
  requireValue(typeof manifest.build.secretInputsUsed === "boolean", "EC_ARTIFACT_MANIFEST_INVALID", "secret input declaration is invalid");
  requireValue(Array.isArray(manifest.build.toolchains) && manifest.build.toolchains.length > 0, "EC_ARTIFACT_MANIFEST_INVALID", "toolchain inventory is invalid");
  const toolchainKeys = [];
  for (const toolchain of manifest.build.toolchains) {
    exactKeys(toolchain, ["name", "version", "executableSha256"]);
    requireValue(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(toolchain.name), "EC_ARTIFACT_MANIFEST_INVALID", "toolchain name is invalid");
    requireValue(typeof toolchain.version === "string" && toolchain.version.length > 0 && toolchain.version.length <= 256, "EC_ARTIFACT_MANIFEST_INVALID", "toolchain version is invalid");
    requireValue(SHA256.test(toolchain.executableSha256), "EC_ARTIFACT_MANIFEST_INVALID", "toolchain digest is invalid");
    toolchainKeys.push(`${toolchain.name}\0${toolchain.version}`);
  }
  requireValue(new Set(toolchainKeys).size === toolchainKeys.length, "EC_ARTIFACT_MANIFEST_INVALID", "toolchain inventory contains duplicates");
  requireValue(toolchainKeys.every((value, index) => index === 0 || compareUtf8(toolchainKeys[index - 1], value) < 0), "EC_ARTIFACT_MANIFEST_INVALID", "toolchain inventory order is invalid");
}

function containsAny(buffer, forbidden) {
  return forbidden.some((needle) => buffer.includes(needle));
}

async function inspectFile(absolutePath, forbidden) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  let tail = Buffer.alloc(0);
  const longest = forbidden.reduce((maximum, value) => Math.max(maximum, value.byteLength), 0);
  for await (const chunk of fs.createReadStream(absolutePath)) {
    size += chunk.byteLength;
    hash.update(chunk);
    if (forbidden.length > 0) {
      const scan = tail.byteLength ? Buffer.concat([tail, chunk]) : chunk;
      requireValue(!containsAny(scan, forbidden), "EC_ARTIFACT_SECRET_EMBEDDED", "artifact contains a forbidden secret value");
      tail = longest > 1 ? scan.subarray(Math.max(0, scan.byteLength - longest + 1)) : Buffer.alloc(0);
    }
  }
  return { size, sha256: hash.digest("hex") };
}

async function walkDirectory(root, forbidden) {
  const files = [];
  async function visit(relativeDirectory) {
    const absoluteDirectory = relativeDirectory ? path.join(root, ...relativeDirectory.split("/")) : root;
    const names = await fsp.readdir(absoluteDirectory);
    names.sort(compareUtf8);
    const childKeys = new Map();
    for (const name of names) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const collisionKey = name.normalize("NFC").toUpperCase();
      const existing = childKeys.get(collisionKey);
      requireValue(existing === undefined || existing === name, "EC_ARTIFACT_PATH_COLLISION", "artifact paths collide on a supported platform");
      childKeys.set(collisionKey, name);
      if (relative !== MANIFEST_PATH) portablePath(relative);
      requireValue(!containsAny(Buffer.from(relative, "utf8"), forbidden), "EC_ARTIFACT_SECRET_EMBEDDED", "artifact contains a forbidden secret value");
      const absolute = path.join(root, ...relative.split("/"));
      const stat = await fsp.lstat(absolute);
      requireValue(!stat.isSymbolicLink(), "EC_ARTIFACT_FILE_TYPE_INVALID", "artifact contains a link or reparse point");
      if (stat.isDirectory()) {
        await visit(relative);
      } else {
        requireValue(stat.isFile() && stat.nlink === 1, "EC_ARTIFACT_FILE_TYPE_INVALID", "artifact contains a non-regular or aliased file");
        if (relative !== MANIFEST_PATH) files.push({ path: relative, ...(await inspectFile(absolute, forbidden)) });
      }
    }
  }
  await visit("");
  files.sort((left, right) => compareUtf8(left.path, right.path));
  return files;
}

export async function validateArtifact(root, options = {}) {
  const forbidden = (options.forbiddenByteSequences ?? []).map((value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    requireValue(bytes.byteLength > 0, "EC_ARTIFACT_VALIDATOR_INPUT_INVALID", "forbidden secret input is invalid");
    return bytes;
  });
  let rootStat;
  try {
    rootStat = await fsp.lstat(root);
  } catch {
    fail("EC_ARTIFACT_INCOMPLETE", "completed artifact directory is unavailable");
  }
  requireValue(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "EC_ARTIFACT_INCOMPLETE", "completed artifact directory is unavailable");

  let manifestBytes;
  try {
    manifestBytes = await fsp.readFile(path.join(root, ".edge-canon", "output.json"));
  } catch {
    fail("EC_ARTIFACT_INCOMPLETE", "canonical manifest is unavailable");
  }
  requireValue(manifestBytes.byteLength <= 4 * 1024 * 1024, "EC_ARTIFACT_MANIFEST_INVALID", "canonical manifest exceeds the validator safety limit");
  requireValue(!containsAny(manifestBytes, forbidden), "EC_ARTIFACT_SECRET_EMBEDDED", "artifact contains a forbidden secret value");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("EC_ARTIFACT_MANIFEST_INVALID", "canonical manifest is not valid JSON");
  }
  validateManifestShape(manifest, options.expectedStandardVersion);
  requireValue(manifestBytes.equals(canonicalJsonBytes(manifest)), "EC_ARTIFACT_NON_CANONICAL_JSON", "canonical manifest bytes are not JCS plus LF");

  const actualFiles = await walkDirectory(root, forbidden);
  const declaredFiles = manifest.content.files;
  requireValue(actualFiles.length === declaredFiles.length, "EC_ARTIFACT_FILE_SET_MISMATCH", "artifact file set differs from the manifest");
  for (let index = 0; index < declaredFiles.length; index += 1) {
    const declared = declaredFiles[index];
    const actual = actualFiles[index];
    requireValue(actual.path === declared.path, "EC_ARTIFACT_FILE_SET_MISMATCH", "artifact file set differs from the manifest");
    requireValue(actual.size === declared.size && actual.sha256 === declared.sha256, "EC_ARTIFACT_DIGEST_MISMATCH", "artifact file content differs from the manifest");
  }
  requireValue(fileSetSha256(declaredFiles) === manifest.content.rootSha256, "EC_ARTIFACT_ROOT_MISMATCH", "artifact content root differs from the manifest");

  return {
    artifactSha256: sha256(manifestBytes),
    contentRootSha256: manifest.content.rootSha256,
    standardVersion: manifest.standard.version,
    fileCount: declaredFiles.length,
    fileDigests: Object.fromEntries(declaredFiles.map((file) => [file.path, file.sha256])),
    documentKinds: manifest.documents.map((document) => document.kind),
    completed: true,
  };
}
