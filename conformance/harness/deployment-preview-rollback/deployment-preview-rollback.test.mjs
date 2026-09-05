import assert from "node:assert/strict";
import test from "node:test";
import { verifyDocument } from "./oracle.mjs";
import { runSuite } from "./runner.mjs";

let observation;
test("reference runner produces a passing EC-DEPLOY observation", async () => {
  observation = await runSuite();
  assert.deepEqual(verifyDocument(observation), {
    suiteId: "EC-DEPLOY", status: "pass",
    caseIds: Array.from({ length: 12 }, (_, index) => `EC-DEPLOY-T${String(index + 1).padStart(3, "0")}`),
  });
});
test("oracle rejects production movement after partial prepare", () => {
  const tampered = structuredClone(observation); tampered.cases[1].data.productionGeneration = "generation-new";
  assert.throws(() => verifyDocument(tampered), /changed production/);
});
test("oracle rejects active before proxy observations", () => {
  const tampered = structuredClone(observation); tampered.cases[3].data.stateWhileAckMissing = "active";
  assert.throws(() => verifyDocument(tampered), /before observations/);
});
test("oracle rejects unstable affinity", () => {
  const tampered = structuredClone(observation); tampered.cases[5].data.assignmentsStable = false;
  assert.throws(() => verifyDocument(tampered), /affinity changed/);
});
test("oracle rejects provider replay after unknown result", () => {
  const tampered = structuredClone(observation); tampered.cases[9].data.providerMutationCount = 2;
  assert.throws(() => verifyDocument(tampered), /replayed provider mutation/);
});
