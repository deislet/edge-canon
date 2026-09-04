import assert from "node:assert/strict";
import test from "node:test";
import { runSuite } from "./runner.mjs";
import { verifyDocument } from "./oracle.mjs";

let observation;

test("reference runner produces a passing EC-ARTIFACT observation", async () => {
  observation = await runSuite();
  assert.deepEqual(verifyDocument(observation), {
    suiteId: "EC-ARTIFACT",
    status: "pass",
    caseIds: Array.from({ length: 8 }, (_, index) => `EC-ARTIFACT-T${String(index + 1).padStart(3, "0")}`),
  });
});

test("oracle rejects a skipped mutation", () => {
  const tampered = structuredClone(observation);
  tampered.cases[3].data.variants[0].code = null;
  assert.throws(() => verifyDocument(tampered), /returned null/);
});

test("oracle rejects reused artifact identity after migration", () => {
  const tampered = structuredClone(observation);
  tampered.cases[7].data.migratedIdentity = tampered.cases[7].data.sourceIdentity;
  assert.throws(() => verifyDocument(tampered), /new identity/);
});

test("oracle rejects a secret leak in diagnostic text", () => {
  const tampered = structuredClone(observation);
  tampered.cases[4].data.canaryLeaked = true;
  assert.throws(() => verifyDocument(tampered), /leaked the secret/);
});
