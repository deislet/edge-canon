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
      "EC-WEB-T006",
      "EC-WEB-T007",
      "EC-WEB-T008",
      "EC-WEB-T009",
      "EC-WEB-T010",
      "EC-WEB-T011",
      "EC-WEB-T012",
      "EC-WEB-T013",
      "EC-WEB-T014",
      "EC-WEB-T015",
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

test("a provider cannot relabel wall time as CPU evidence", () => {
  const tampered = structuredClone(sample);
  tampered.cases[11].data.measurementKind = "wall-time";
  assert.throws(() => verifyDocument(tampered), /wall time/);
});

test("the subrequest oracle rejects the former off-by-one fixture", () => {
  const tampered = structuredClone(sample);
  tampered.cases[12].data.fetchCallCount = 50;
  tampered.cases[12].data.subrequestStartCount = 51;
  tampered.cases[12].data.originRequestCount = 51;
  assert.throws(() => verifyDocument(tampered), /49 fetch API calls/);
});

test("a provider cannot omit the exact standard commit", () => {
  const tampered = structuredClone(sample);
  tampered.backend.standardVersion = "edge-canon.next";
  assert.throws(() => verifyDocument(tampered), /exact standard commit/);
});

test("a provider cannot hide cross-request marker mixing", () => {
  const tampered = structuredClone(sample);
  tampered.cases[5].data.responses[0].responseMarker = "request-1";
  assert.throws(() => verifyDocument(tampered), /mixed request markers/);
});

test("adapter transport headers cannot reach application code", () => {
  const tampered = structuredClone(sample);
  tampered.cases[1].data.transportHeadersRemoved = false;
  assert.throws(() => verifyDocument(tampered), /transport headers/);
});

test("a provider cannot truncate the one-million-octet request body", () => {
  const tampered = structuredClone(sample);
  tampered.cases[14].data.receivedByteLength -= 1;
  assert.throws(() => verifyDocument(tampered), /truncated or expanded/);
});
