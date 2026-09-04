import fs from "node:fs";
import { fileURLToPath } from "node:url";

const EXPECTED_CASES = Array.from({ length: 9 }, (_, index) => `EC-ARTIFACT-T${String(index + 1).padStart(3, "0")}`);
const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_STANDARD_VERSION = /^edge-canon\.next@[0-9a-f]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  requireValue(JSON.stringify(actual) === JSON.stringify(expected), `${label} keys differ: ${actual.join(",")}`);
}

function allExpectedCodes(values) {
  requireValue(Array.isArray(values) && values.length > 0, "mutation evidence is missing");
  for (const value of values) {
    requireValue(value.code === value.expected, `${value.variant} returned ${value.code} instead of ${value.expected}`);
  }
}

const VERIFIERS = {
  "EC-ARTIFACT-T001"(data, document) {
    exactKeys(data, ["artifactSha256", "manifestSha256", "contentRootSha256", "fileCount", "inventoryComplete", "documentKinds", "standardVersion", "canonicalManifest", "completedRoot"], "T001 data");
    requireValue(data.artifactSha256 === document.artifactSha256 && data.manifestSha256 === document.artifactSha256, "T001 artifact identity is not the manifest digest");
    requireValue(SHA256.test(data.contentRootSha256) && Number.isSafeInteger(data.fileCount) && data.fileCount >= 6, "T001 content inventory is invalid");
    requireValue(data.inventoryComplete === true && data.canonicalManifest === true && data.completedRoot === true, "T001 artifact is not complete and canonical");
    requireValue(JSON.stringify(data.documentKinds) === JSON.stringify(["provenance", "runtime-entrypoints", "sbom", "validation-report"]), "T001 required semantic documents differ");
    requireValue(data.standardVersion === document.backend.standardVersion, "T001 standard pin differs");
  },
  "EC-ARTIFACT-T002"(data) {
    exactKeys(data, ["artifactIdentities", "contentRoots", "manifestBytesEqual", "fileDigestsEqual", "absoluteDirectoryEmbedded"], "T002 data");
    requireValue(data.artifactIdentities.length === 2 && data.artifactIdentities[0] === data.artifactIdentities[1], "T002 artifact identities differ");
    requireValue(data.contentRoots.length === 2 && data.contentRoots[0] === data.contentRoots[1], "T002 content roots differ");
    requireValue(data.manifestBytesEqual === true && data.fileDigestsEqual === true, "T002 output bytes differ");
    requireValue(data.absoluteDirectoryEmbedded === false, "T002 embedded an absolute build directory");
  },
  "EC-ARTIFACT-T003"(data) {
    exactKeys(data, ["stagingPathsDistinct", "publishedRootsDistinct", "bothValid", "markerIsolation"], "T003 data");
    requireValue(Object.values(data).every((value) => value === true), "T003 concurrent builds mixed or failed publication");
  },
  "EC-ARTIFACT-T004"(data) {
    exactKeys(data, ["variants", "messagesSanitized"], "T004 data");
    allExpectedCodes(data.variants);
    requireValue(data.messagesSanitized === true, "T004 error messages leaked host or file details");
  },
  "EC-ARTIFACT-T005"(data) {
    exactKeys(data, ["providerFieldCode", "secretContentCode", "secretPathCode", "canaryLeaked"], "T005 data");
    requireValue(data.providerFieldCode === "EC_ARTIFACT_MANIFEST_INVALID", "T005 provider field was accepted");
    requireValue(data.secretContentCode === "EC_ARTIFACT_SECRET_EMBEDDED" && data.secretPathCode === "EC_ARTIFACT_SECRET_EMBEDDED", "T005 secret canary was accepted");
    requireValue(data.canaryLeaked === false, "T005 error text leaked the secret canary");
  },
  "EC-ARTIFACT-T006"(data) {
    exactKeys(data, ["variants", "derivationAttempts", "autoRepairs"], "T006 data");
    const expected = new Map([
      ["modified", "EC_ARTIFACT_DIGEST_MISMATCH"],
      ["deleted", "EC_ARTIFACT_FILE_SET_MISMATCH"],
      ["added", "EC_ARTIFACT_FILE_SET_MISMATCH"],
      ["document", "EC_ARTIFACT_DOCUMENT_INVALID"],
      ["noncanonical", "EC_ARTIFACT_NON_CANONICAL_JSON"],
    ]);
    requireValue(data.variants.length === expected.size, "T006 mutation set is incomplete");
    for (const value of data.variants) requireValue(value.code === expected.get(value.variant), `T006 ${value.variant} did not fail closed`);
    requireValue(data.derivationAttempts === 0 && data.autoRepairs === 0, "T006 corrupted output reached derivation or was repaired");
  },
  "EC-ARTIFACT-T007"(data) {
    exactKeys(data, ["faults", "completedArtifactIdentities"], "T007 data");
    requireValue(data.faults.length === 3, "T007 fault set is incomplete");
    requireValue(data.faults.every((value) => value.code === "EC_ARTIFACT_BUILD_FAILED" && value.publishedRootExists === false), "T007 build failure left a completed root");
    requireValue(data.completedArtifactIdentities === 0, "T007 exposed an identity for an incomplete artifact");
  },
  "EC-ARTIFACT-T008"(data) {
    exactKeys(data, ["versions", "semanticDocumentsReadBeforeRejection", "sourceIdentity", "migratedIdentity", "sourceMutated", "lineageRecorded"], "T008 data");
    allExpectedCodes(data.versions);
    requireValue(data.semanticDocumentsReadBeforeRejection === false, "T008 read semantic documents before rejecting the version");
    requireValue(SHA256.test(data.sourceIdentity) && SHA256.test(data.migratedIdentity) && data.sourceIdentity !== data.migratedIdentity, "T008 migration did not create a new identity");
    requireValue(data.sourceMutated === false && data.lineageRecorded === true, "T008 migration mutated its input or lost lineage");
  },
  "EC-ARTIFACT-T009"(data) {
    exactKeys(data, ["validGraph", "external", "missing", "credentialLeaked"], "T009 data");
    exactKeys(data.validGraph, ["moduleCount", "fileEdges", "runtimeEdges", "closed"], "T009 valid graph");
    requireValue(JSON.stringify(data.validGraph) === JSON.stringify({ moduleCount: 2, fileEdges: 1, runtimeEdges: 1, closed: true }), "T009 valid graph did not close over artifact/runtime modules");
    requireValue(data.external.length === 7 && data.external.every((value) => value.code === "EC_ARTIFACT_MODULE_EXTERNAL"), "T009 external module edge was accepted or used a divergent code");
    requireValue(data.missing.length === 2 && data.missing.every((value) => value.code === "EC_ARTIFACT_MODULE_MISSING"), "T009 missing module edge was accepted or used a divergent code");
    requireValue(data.credentialLeaked === false, "T009 diagnostic leaked URL credentials");
  },
};

export function verifyDocument(document) {
  exactKeys(document, ["schemaVersion", "standardId", "suiteId", "backend", "artifactSha256", "cases"], "observation document");
  requireValue(document.schemaVersion === 1 && document.standardId === "edge-canon.next" && document.suiteId === "EC-ARTIFACT", "observation identity differs");
  requireValue(SHA256.test(document.artifactSha256), "artifact digest is invalid");
  exactKeys(document.backend, ["id", "implementationVersion", "standardVersion"], "backend");
  requireValue(document.backend.id === "edge-canon-reference-validator", "reference backend id differs");
  requireValue(document.backend.implementationVersion === "edge-canon-reference-artifact-harness/1", "reference implementation version differs");
  requireValue(EXACT_STANDARD_VERSION.test(document.backend.standardVersion), "backend did not run an exact standard commit");
  requireValue(Array.isArray(document.cases), "cases must be an array");
  const byId = new Map();
  for (const item of document.cases) {
    exactKeys(item, ["id", "observedAt", "data", "evidenceRefs"], "case record");
    requireValue(!byId.has(item.id), `duplicate case ${item.id}`);
    requireValue(Number.isFinite(Date.parse(item.observedAt)), `${item.id} observedAt is invalid`);
    requireValue(Array.isArray(item.evidenceRefs) && new Set(item.evidenceRefs).size === item.evidenceRefs.length && item.evidenceRefs.every((value) => typeof value === "string" && value.length > 0), `${item.id} evidence references are invalid`);
    byId.set(item.id, item);
  }
  requireValue(byId.size === EXPECTED_CASES.length && EXPECTED_CASES.every((id) => byId.has(id)), "draft harness requires exactly nine artifact cases");
  for (const id of EXPECTED_CASES) VERIFIERS[id](byId.get(id).data, document);
  return { suiteId: "EC-ARTIFACT", status: "pass", caseIds: [...EXPECTED_CASES] };
}

function main(file) {
  requireValue(file, "usage: node oracle.mjs OBSERVATIONS.json");
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  process.stdout.write(`${JSON.stringify(verifyDocument(document), null, 2)}\n`);
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  try {
    main(process.argv[2]);
  } catch (error) {
    process.stderr.write(`EC-ARTIFACT oracle failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
