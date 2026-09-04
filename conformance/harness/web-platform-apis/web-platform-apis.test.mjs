import assert from "node:assert/strict";
import test from "node:test";
import { capabilityLock } from "./fixture.mjs";
import { verifyDocument } from "./oracle.mjs";
import { captureContractFailure, deriveProviderConfiguration, validateCapabilityLock } from "./reference-runtime.mjs";
import { runSuite } from "./runner.mjs";

const STANDARD_VERSION = "edge-canon.next@0000000000000000000000000000000000000000";

test("EC-WEBAPI reference suite passes all fourteen cases", async () => {
  const observations = await runSuite({ standardVersion: STANDARD_VERSION });
  const result = verifyDocument(observations);
  assert.equal(result.status, "pass");
  assert.equal(result.caseIds.length, 14);
});

test("EC-WEBAPI oracle rejects a missing case", async () => {
  const observations = await runSuite({ standardVersion: STANDARD_VERSION });
  observations.cases.pop();
  assert.throws(() => verifyDocument(observations), /exactly fourteen/);
});

test("EC-WEBAPI oracle rejects response/request cross-association", async () => {
  const observations = await runSuite({ standardVersion: STANDARD_VERSION });
  const value = observations.cases.find((item) => item.id === "EC-WEBAPI-T011");
  value.data.results[0].body = "body-2";
  assert.throws(() => verifyDocument(observations), /another request/);
});

test("EC-WEBAPI capability lock rejects semantic drift", () => {
  const lock = capabilityLock(STANDARD_VERSION);
  assert.equal(validateCapabilityLock(lock, STANDARD_VERSION), lock);
  const floating = structuredClone(lock);
  floating.standardVersion = "edge-canon.next@main";
  assert.equal(captureContractFailure(floating, STANDARD_VERSION), "EC_WEBAPI_STANDARD_PIN_INVALID");
  const unknown = structuredClone(lock);
  unknown.vendor = "cloudflare";
  assert.equal(captureContractFailure(unknown, STANDARD_VERSION), "EC_WEBAPI_DOCUMENT_INVALID");
});

test("EC-WEBAPI provider configuration derives standard URL semantics", () => {
  const lock = capabilityLock(STANDARD_VERSION);
  assert.deepEqual(deriveProviderConfiguration(lock, "cloudflare-workers-pages"), {
    providerId: "cloudflare-workers-pages",
    urlParser: "standard",
    responseRedirectUrlParser: "standard",
    compatibilityDateFloor: "2023-03-14",
    redirectCredentials: "edge-canon-shim",
  });
});
