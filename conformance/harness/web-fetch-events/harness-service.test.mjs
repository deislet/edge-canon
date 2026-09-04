import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startHarnessService } from "./harness-service.mjs";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const token = "harness_service_token_12345678901234567890";

function authorization() {
  return { authorization: `Bearer ${token}` };
}

async function control(service, pathName, method = "GET") {
  const response = await fetch(`${service.baseUrl}/__edge-canon/control/${pathName}`, {
    method,
    headers: authorization(),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("harness service durably authenticates and de-duplicates structured evidence", async (context) => {
  const root = fs.mkdtempSync(path.join(repositoryRoot, ".edge-canon-service-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let service = await startHarnessService({ stateDirectory: root, token });
  context.after(async () => service?.close());

  assert.equal((await fetch(service.evidenceSinkUrl)).status, 401);
  const record = {
    schemaVersion: 1,
    backendId: "deislet",
    event: "invocation-start",
    invocationId: "service-test-1",
    eventSequence: 0,
    method: "GET",
    pathname: "/sync",
  };
  const first = await fetch(service.evidenceSinkUrl, {
    method: "POST",
    headers: { ...authorization(), "content-type": "application/json" },
    body: JSON.stringify(record),
  });
  assert.equal(first.status, 202);
  const duplicate = await fetch(service.evidenceSinkUrl, {
    method: "POST",
    headers: { ...authorization(), "content-type": "application/json" },
    body: JSON.stringify(record),
  });
  assert.equal(duplicate.status, 409);
  const listed = await fetch(service.evidenceSinkUrl, { headers: authorization() });
  assert.deepEqual((await listed.json()).records.map(({ record: value }) => value), [record]);
  assert.equal(fs.statSync(path.join(root, "evidence.ndjson")).mode & 0o777, 0o600);

  await service.close();
  service = await startHarnessService({ stateDirectory: root, token });
  const recovered = await fetch(service.evidenceSinkUrl, { headers: authorization() });
  const recoveredDocument = await recovered.json();
  assert.equal(recoveredDocument.records.length, 1);
  assert.deepEqual(recoveredDocument.records[0].record, record);
});

test("controlled origin counts the redirect hop independently", async (context) => {
  const root = fs.mkdtempSync(path.join(repositoryRoot, ".edge-canon-origin-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = await startHarnessService({ stateDirectory: root, token });
  context.after(() => service.close());
  await control(service, "origin/reset", "POST");
  for (let index = 0; index < 48; index += 1) {
    assert.equal((await fetch(`${service.baseUrl}/direct/${index}`)).status, 200);
  }
  const redirected = await fetch(`${service.baseUrl}/redirect-once`);
  assert.equal(redirected.status, 200);
  assert.equal(await redirected.text(), "redirect-target");
  assert.deepEqual(await control(service, "origin/status"), {
    armed: true,
    directIndices: Array.from({ length: 48 }, (_, index) => index),
    redirectRequestCount: 1,
    redirectTargetCount: 1,
    totalRequestCount: 50,
  });
});

test("connection barrier witnesses six waiting headers before release", async (context) => {
  const root = fs.mkdtempSync(path.join(repositoryRoot, ".edge-canon-barrier-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = await startHarnessService({ stateDirectory: root, token });
  context.after(() => service.close());
  await control(service, "barrier/reset", "POST");
  const firstSix = Array.from({ length: 6 }, (_, slot) =>
    fetch(`${service.baseUrl}/slot/${slot}`).then((response) => response.text()));
  let status;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = await control(service, "barrier/status");
    if (status.waitingSlots.length === 6) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(status.waitingSlots, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(status.cancelledSlots, []);
  assert.deepEqual(await control(service, "barrier/release", "POST"), {
    releasedSlots: [0, 1, 2, 3, 4, 5],
  });
  assert.deepEqual(await Promise.all(firstSix), [
    "connection-0", "connection-1", "connection-2", "connection-3", "connection-4", "connection-5",
  ]);
  assert.equal(await (await fetch(`${service.baseUrl}/slot/6`)).text(), "connection-6");
  const finalStatus = await control(service, "barrier/status");
  assert.deepEqual(finalStatus.startedSlots, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(finalStatus.cancelledSlots, []);
});
