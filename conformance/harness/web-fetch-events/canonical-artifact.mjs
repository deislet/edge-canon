import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const STANDARD_VERSION = /^edge-canon\.next@([0-9a-f]{40})$/;
const CANONICAL_FILES = [
  {
    repositoryPath: "conformance/harness/web-fetch-events/cpu-workload.mjs",
    artifactPath: "cpu-workload.mjs",
  },
  {
    repositoryPath: "conformance/harness/web-fetch-events/fixture.mjs",
    artifactPath: "fixture.mjs",
  },
];

function fail(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function serializeArtifactManifest(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function git(repositoryRoot, args) {
  try {
    return execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    const detail = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString("utf8").trim()
      : error?.message;
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

function writeFile(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, contents, { flag: "wx", mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

export function buildCanonicalArtifact({ repositoryRoot, standardVersion, outputDirectory }) {
  fail(typeof repositoryRoot === "string" && path.isAbsolute(repositoryRoot), "repositoryRoot must be absolute");
  fail(typeof outputDirectory === "string" && path.isAbsolute(outputDirectory), "outputDirectory must be absolute");
  const match = STANDARD_VERSION.exec(standardVersion);
  fail(match, "standardVersion must pin edge-canon.next to a 40-character commit");
  fail(fs.statSync(repositoryRoot, { throwIfNoEntry: false })?.isDirectory(), "repositoryRoot is not a directory");
  fail(!fs.existsSync(outputDirectory), "outputDirectory already exists");
  const parent = path.dirname(outputDirectory);
  fail(fs.statSync(parent, { throwIfNoEntry: false })?.isDirectory(), "outputDirectory parent is not a directory");

  const revision = git(repositoryRoot, ["rev-parse", `${match[1]}^{commit}`]).toString("utf8").trim();
  fail(revision === match[1], "standardVersion does not resolve to the requested commit");

  const staged = fs.mkdtempSync(path.join(parent, ".edge-canon-canonical-"));
  try {
    const files = [];
    for (const source of CANONICAL_FILES) {
      const contents = git(repositoryRoot, ["show", `${revision}:${source.repositoryPath}`]);
      writeFile(staged, source.artifactPath, contents);
      files.push({
        path: source.artifactPath,
        size: contents.byteLength,
        sha256: sha256(contents),
      });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const manifest = {
      schemaVersion: 1,
      artifactFormat: "edge-canon.canonical-artifact/v1",
      standardVersion,
      suiteId: "EC-WEB",
      entrypoint: "fixture.mjs",
      files,
    };
    const manifestBytes = serializeArtifactManifest(manifest);
    writeFile(staged, "edge-canon-canonical-artifact.json", manifestBytes);
    fs.renameSync(staged, outputDirectory);
    return {
      canonicalArtifactPath: path.join(outputDirectory, "edge-canon-canonical-artifact.json"),
      canonicalArtifactSha256: sha256(manifestBytes),
      standardVersion,
    };
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    fail(typeof value === "string", `missing value for ${name ?? "argument"}`);
    if (name === "--repository") values.repositoryRoot = value;
    else if (name === "--standard-version") values.standardVersion = value;
    else if (name === "--output") values.outputDirectory = value;
    else throw new Error(`unknown argument ${name}`);
  }
  fail(Object.keys(values).length === 3, "usage: canonical-artifact.mjs --repository <absolute> --standard-version <exact> --output <absolute>");
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(buildCanonicalArtifact(parseArguments(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`canonical artifact build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
