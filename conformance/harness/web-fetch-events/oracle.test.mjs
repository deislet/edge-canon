import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { verifyDocument } from "./oracle.mjs";

const sample = JSON.parse(
  fs.readFileSync(new URL("./sample-pass.json", import.meta.url), "utf8"),
);

test("the complete draft sample passes", () => {
  assert.deepEqual(verifyDocument(sample), {
    suiteId: "EC-WEB",
    status: "pass",
    caseIds: [
      "EC-WEB-T001",
      "EC-WEB-T002",
      "EC-WEB-T003",
      "EC-WEB-T004",
      "EC-WEB-T005",
    ],
  });
});

test("a provider cannot pass by leaking the thrown secret", () => {
  const tampered = structuredClone(sample);
  tampered.cases[3].data.attempts[0].leakedSentinel = true;
  assert.throws(() => verifyDocument(tampered), /leaked the exception sentinel/);
});

test("a provider cannot omit a draft case", () => {
  const incomplete = structuredClone(sample);
  incomplete.cases.pop();
  assert.throws(() => verifyDocument(incomplete), /requires exactly/);
});
