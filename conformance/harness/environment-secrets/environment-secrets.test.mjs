import assert from "node:assert/strict";
import test from "node:test";
import { verifyDocument } from "./oracle.mjs";
import { runSuite } from "./runner.mjs";

let observation;

test("reference runner produces a passing EC-ENV observation", async () => {
  observation = await runSuite();
  assert.deepEqual(verifyDocument(observation), {
    suiteId: "EC-ENV",
    status: "pass",
    caseIds: Array.from({ length: 12 }, (_, index) => `EC-ENV-T${String(index + 1).padStart(3, "0")}`),
  });
});

test("oracle rejects provider binding exposure", () => {
  const tampered = structuredClone(observation);
  tampered.cases[0].data.providerExtraVisible = true;
  assert.throws(() => verifyDocument(tampered), /provider binding/);
});

test("oracle rejects a mixed snapshot", () => {
  const tampered = structuredClone(observation);
  tampered.cases[5].data.mixedPairCount = 1;
  assert.throws(() => verifyDocument(tampered), /mixed snapshot/);
});

test("oracle rejects a secret readback", () => {
  const tampered = structuredClone(observation);
  tampered.cases[9].data.metadataHasValue = true;
  assert.throws(() => verifyDocument(tampered), /returned a value/);
});

test("oracle rejects late version validation", () => {
  const tampered = structuredClone(observation);
  tampered.cases[11].data.versions[0].secretReads = 1;
  assert.throws(() => verifyDocument(tampered), /late or unstable/);
});
