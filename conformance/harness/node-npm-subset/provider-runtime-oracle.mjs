import fs from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BUILTIN_MODULES } from "./fixture.mjs";
import { verifyCaseData } from "./oracle.mjs";

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  requireValue(equal(Object.keys(value).sort(), [...keys].sort()), `${label} fields differ`);
}

function validateResponse(document, expectedLabel) {
  exactKeys(document, ["schemaVersion", "suiteId", "label", "cases", "invocation"], `${expectedLabel} response`);
  requireValue(document.schemaVersion === 1 && document.suiteId === "EC-NODE" && document.label === expectedLabel, `${expectedLabel} response identity differs`);
  requireValue(Array.isArray(document.cases), `${expectedLabel} cases are missing`);
  const expectedIds = Array.from({ length: 7 }, (_, index) => `EC-NODE-T${String(index + 1).padStart(3, "0")}`);
  requireValue(equal(document.cases.map(({ id }) => id), expectedIds), `${expectedLabel} runtime case set differs`);
  for (const item of document.cases) exactKeys(item, ["id", "data"], `${expectedLabel} ${item.id}`);

  const inventory = document.cases[0].data?.inventory;
  requireValue(Array.isArray(inventory) && inventory.length === Object.keys(BUILTIN_MODULES).length, `${expectedLabel} builtin inventory count differs`);
  for (const item of inventory) {
    exactKeys(item, ["specifier", "exports", "present", "missing", "visible"], `${expectedLabel} builtin inventory item`);
    const selected = BUILTIN_MODULES[item.specifier];
    requireValue(selected !== undefined, `${expectedLabel} exposed an unknown builtin`);
    requireValue(equal(item.exports, selected) && equal(item.present, selected) && equal(item.missing, []), `${expectedLabel} ${item.specifier} is missing a selected export`);
    requireValue(equal(item.visible, [...selected].sort()), `${expectedLabel} ${item.specifier} exposes fields outside the lock`);
  }
  for (const item of document.cases.slice(1)) verifyCaseData(item.id, item.data);

  exactKeys(
    document.invocation,
    ["label", "before", "environment", "version", "nodeVersion", "platform", "visibleFields", "hostFieldsHidden", "builtin"],
    `${expectedLabel} invocation`,
  );
  requireValue(document.invocation.label === expectedLabel && document.invocation.before === "initial", `${expectedLabel} invocation did not receive the initial environment`);
  requireValue(document.invocation.hostFieldsHidden === true, `${expectedLabel} invocation exposed host process fields`);
  return document;
}

export function verifyProviderRuntimeResponses(documents) {
  requireValue(Array.isArray(documents) && documents.length === 2, "provider runtime requires exactly two responses");
  const byLabel = new Map(documents.map((document) => [document?.label, document]));
  requireValue(byLabel.size === 2 && byLabel.has("A") && byLabel.has("B"), "provider runtime responses must contain A and B once");
  const a = validateResponse(byLabel.get("A"), "A");
  const b = validateResponse(byLabel.get("B"), "B");
  const t012 = {
    version: a.invocation.version,
    nodeVersion: a.invocation.nodeVersion,
    platform: a.invocation.platform,
    env: { A: a.invocation.environment, B: b.invocation.environment },
    visibleFields: a.invocation.visibleFields,
    builtin: a.invocation.builtin,
  };
  requireValue(
    b.invocation.version === t012.version &&
      b.invocation.nodeVersion === t012.nodeVersion &&
      b.invocation.platform === t012.platform &&
      equal(b.invocation.visibleFields, t012.visibleFields) &&
      equal(b.invocation.builtin, t012.builtin),
    "provider runtime identity changed between invocations",
  );
  verifyCaseData("EC-NODE-T012", t012);
  return {
    suiteId: "EC-NODE",
    status: "runtime-pass",
    runtimeCaseIds: ["EC-NODE-T001", "EC-NODE-T002", "EC-NODE-T003", "EC-NODE-T004", "EC-NODE-T005", "EC-NODE-T006", "EC-NODE-T007", "EC-NODE-T012"],
  };
}

function main(paths) {
  requireValue(paths.length === 2, "usage: node provider-runtime-oracle.mjs RESPONSE_A.json RESPONSE_B.json");
  const documents = paths.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  process.stdout.write(`${JSON.stringify(verifyProviderRuntimeResponses(documents), null, 2)}\n`);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`EC-NODE provider runtime oracle failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
