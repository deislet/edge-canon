import assert from "node:assert/strict";
import test from "node:test";
import { verifyDocument } from "./oracle.mjs";
import { runSuite } from "./runner.mjs";

let observation;
test("reference runner produces a passing EC-DEPLOY observation", async () => {
  observation = await runSuite();
  assert.deepEqual(verifyDocument(observation), {
    suiteId: "EC-DEPLOY", status: "pass",
    caseIds: Array.from({ length: 14 }, (_, index) => `EC-DEPLOY-T${String(index + 1).padStart(3, "0")}`),
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
test("oracle rejects queue admission reopening while prepared", () => {
  const tampered = structuredClone(observation); tampered.cases[12].data.pullWhilePreparedCode = null;
  assert.throws(() => verifyDocument(tampered), /PREPARED accepted/);
});
test("oracle rejects selector movement before the prepared trigger barrier", () => {
  const tampered = structuredClone(observation); tampered.cases[12].data.selectorWhilePrepared.generation = "generation-new";
  assert.throws(() => verifyDocument(tampered), /moved selector/);
});
test("oracle rejects trigger activation before complete proxy observation", () => {
  const tampered = structuredClone(observation); tampered.cases[12].data.partialObservationActivationCode = null;
  assert.throws(() => verifyDocument(tampered), /before every proxy/);
});
test("oracle rejects stale lease settlement mutating the message", () => {
  const tampered = structuredClone(observation); tampered.cases[12].data.messageStatesAfterStaleSettle.ack = "deleted";
  assert.throws(() => verifyDocument(tampered), /expired lease changed/);
});
test("oracle rejects duplicate recovered production commit", () => {
  const tampered = structuredClone(observation); tampered.cases[13].data.selectorCommitEffects = 2;
  assert.throws(() => verifyDocument(tampered), /duplicated side effects/);
});
test("oracle rejects partial identity being treated as completed idempotence", () => {
  const tampered = structuredClone(observation); tampered.cases[13].data.completedIdentityConflict = null;
  assert.throws(() => verifyDocument(tampered), /partial completed identity/);
});
test("oracle rejects duplicate abort side effects after recovery", () => {
  const tampered = structuredClone(observation); tampered.cases[13].data.abortEffects = 2;
  assert.throws(() => verifyDocument(tampered), /abort recovery/);
});
