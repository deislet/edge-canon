import assert from "node:assert/strict";
import test from "node:test";
import { runSuite } from "./runner.mjs";
import { verifyDocument } from "./oracle.mjs";

let observation;

test("reference runner produces a passing EC-ROUTING observation", async () => {
  observation = await runSuite();
  assert.deepEqual(verifyDocument(observation), {
    suiteId: "EC-ROUTING",
    status: "pass",
    caseIds: Array.from({ length: 11 }, (_, index) => `EC-ROUTING-T${String(index + 1).padStart(3, "0")}`),
  });
});

test("oracle rejects asset/function precedence drift", () => {
  const tampered = structuredClone(observation);
  tampered.cases[0].data.assetFunctionCollision.kind = "function";
  assert.throws(() => verifyDocument(tampered), /asset did not win/);
});

test("oracle rejects an unsafe-path skip", () => {
  const tampered = structuredClone(observation);
  tampered.cases[7].data.requests[0].status = 200;
  assert.throws(() => verifyDocument(tampered), /unsafe request path/);
});

test("oracle rejects mixed deployment snapshots", () => {
  const tampered = structuredClone(observation);
  tampered.cases[8].data.mixedPairCount = 1;
  assert.throws(() => verifyDocument(tampered), /mixed snapshot/);
});

test("oracle rejects late version validation", () => {
  const tampered = structuredClone(observation);
  tampered.cases[10].data.versions[0].assetReadsBeforeRejection = 1;
  assert.throws(() => verifyDocument(tampered), /version rejection was late/);
});
