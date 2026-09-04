import test from "node:test";
import assert from "node:assert/strict";
import handler from "./fixture.mjs";
import * as fixtureModule from "./fixture.mjs";

function context(path, init = {}) {
  const background = [];
  return {
    value: {
      request: new Request(`https://fixture.invalid${path}`, init),
      env: {
        TEST_VALUE: "edge-canon-env",
        EVIDENCE: {
          record(value) {
            background.push(value);
            return Promise.resolve();
          },
        },
      },
      params: { name: "edge-canon-param" },
      waitUntil(promise) {
        background.push(promise);
      },
    },
    background,
  };
}

test("fixture exposes one default handler and its sync response", async () => {
  assert.deepEqual(Object.keys(fixtureModule), ["default"]);
  const response = await handler(context("/sync").value);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "edge-canon-sync");
});

test("fixture exercises the four context fields and async settlement", async () => {
  const call = context("/context");
  const response = await handler(call.value);
  assert.deepEqual(await response.json(), {
    contextKeys: ["env", "params", "request", "waitUntil"],
    environment: "edge-canon-env",
    parameter: "edge-canon-param",
  });
  assert.equal(call.background[0], "background-complete");
  await call.background[1];
});

test("fixture routes methods, throws and invalid results without a second entrypoint", async () => {
  const method = context("/method", { method: "PURGE", body: "purge-body" });
  assert.equal(await (await handler(method.value)).text(), "PURGE:purge-body");
  assert.throws(() => handler(context("/throw-sync").value), /EC_WEB_SECRET_MUST_NOT_LEAK/);
  await assert.rejects(handler(context("/throw-async").value), /EC_WEB_SECRET_MUST_NOT_LEAK/);
  assert.equal(handler(context("/invalid-undefined").value), undefined);
  assert.equal(handler(context("/invalid-string").value), "not a response");
  assert.deepEqual(handler(context("/invalid-object").value), {
    status: 200,
    body: "not a response",
  });
});
