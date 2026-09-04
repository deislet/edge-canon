import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import handler from "./fixture.mjs";
import * as fixtureModule from "./fixture.mjs";

test("fixture itself stays inside the locked EC-STREAM application surface", () => {
  const source = fs.readFileSync(new URL("./fixture.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bnew\s+(?:globalThis\.)?(?:ReadableStream|WritableStream)\s*\(/);
  assert.match(source, /new TransformStream\(\)/);
});

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
    contextObjectIdentityUnique: true,
    environment: "edge-canon-env",
    parameter: "edge-canon-param",
  });
  assert.equal(call.background[0], "background-complete");
  await call.background[1];
});

test("fixture can witness removal of adapter transport headers", async () => {
  const call = context("/transport-headers", {
    headers: {
      "x-edge-canon-evidence-mode": "off",
      "x-edge-canon-evidence-token": "transport-secret",
      "x-edge-canon-invocation-id": "transport-invocation",
    },
  });
  assert.deepEqual(await (await handler(call.value)).json(), {
    evidenceMode: "off",
    evidenceToken: "transport-secret",
    invocationId: "transport-invocation",
  });
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

test("fixture exposes concurrent markers without relying on module persistence", async () => {
  const calls = Array.from({ length: 8 }, (_, index) => {
    const marker = `request-${index}`;
    return handler(context(`/concurrent?marker=${marker}&delay=${7 - index}`).value)
      .then((response) => response.json())
      .then((body) => ({ marker, body }));
  });
  const observations = await Promise.all(calls);
  for (const { marker, body } of observations) {
    assert.equal(body.marker, marker);
    assert.equal(body.contextObjectIdentityUnique, true);
    assert.equal(Number.isSafeInteger(body.moduleCounterSample), true);
  }
});

test("fixture streams three chunks after the handler has returned", async () => {
  const response = handler(context("/stream").value);
  assert.equal(response instanceof Response, true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value));
  }
  assert.deepEqual(chunks, ["stream-one", "stream-two", "stream-three"]);
});

test("fixture registers independent background tasks including one rejection", async () => {
  const call = context("/background");
  const response = handler(call.value);
  assert.equal(await response.text(), "background-response");
  const registered = call.background.slice(0, 3);
  const settled = await Promise.allSettled(registered);
  assert.deepEqual(settled.map(({ status }) => status), ["fulfilled", "rejected", "fulfilled"]);
  assert.deepEqual(
    call.background.filter((value) => typeof value === "string"),
    ["background-first", "background-third"],
  );
});

test("fixture calls a captured waitUntil after its lifecycle is closed", async () => {
  let closed = false;
  const capture = context("/capture-wait-until");
  const tasks = [];
  capture.value.waitUntil = (promise) => {
    if (closed) {
      const error = new TypeError("waitUntil closed");
      Object.defineProperty(error, "code", { value: "EC_WAIT_UNTIL_CLOSED" });
      throw error;
    }
    tasks.push(Promise.resolve(promise));
  };
  assert.equal(await handler(capture.value).text(), "wait-until-captured");
  closed = true;
  await Promise.all(tasks);
  assert.ok(capture.background.includes("late-wait-until:TypeError:EC_WAIT_UNTIL_CLOSED"));
});

test("fixture exposes the standard calibrated CPU workload", async () => {
  const call = context("/cpu");
  call.value.env.CPU_ITERATIONS = 10_000;
  const body = await (await handler(call.value)).json();
  assert.equal(body.completionSentinel, "cpu-work-complete");
  assert.equal(Number.isSafeInteger(body.checksum), true);
});

test("fixture records one disconnected invocation and isolates a later probe", async () => {
  const disconnected = context("/disconnect?marker=disconnect-one");
  const response = handler(disconnected.value);
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first:disconnect-one");
  await reader.cancel();
  await Promise.allSettled(disconnected.background.filter((value) => value instanceof Promise));
  assert.deepEqual(
    disconnected.background.filter((value) => typeof value === "string"),
    ["invocation:disconnect-one", "background:disconnect-one", "body-cancelled:disconnect-one"],
  );
  const probe = handler(context("/probe?marker=probe-two").value);
  assert.equal(await probe.text(), "probe:probe-two");
});

test("fixture performs 49 fetch calls for a fifty-subrequest redirect case", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response("controlled");
  };
  try {
    const call = context("/subrequests");
    call.value.env.CONTROLLED_ORIGIN = "https://origin.invalid/base";
    const response = await handler(call.value);
    assert.deepEqual(await response.json(), {
      completionSentinel: "fifty-subrequests-complete",
      fetchCallCount: 49,
    });
    assert.equal(urls.length, 49);
    assert.equal(urls.at(-1), "https://origin.invalid/redirect-once");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fixture opens seven connection probes and preserves every marker", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const index = new URL(input).pathname.split("/").at(-1);
    return new Response(`connection-${index}`);
  };
  try {
    const call = context("/connections");
    call.value.env.CONNECTION_BARRIER_ORIGIN = "https://origin.invalid/";
    const response = await handler(call.value);
    assert.deepEqual((await response.json()).markers, [
      "connection-0",
      "connection-1",
      "connection-2",
      "connection-3",
      "connection-4",
      "connection-5",
      "connection-6",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fixture reads the exact one-million-octet request body", async () => {
  const body = new Uint8Array(1_000_000);
  for (let index = 0; index < body.length; index += 1) body[index] = index % 251;
  const call = context("/request-body-limit", {
    method: "POST",
    headers: { "content-length": "1000000" },
    body,
  });
  const response = await handler(call.value);
  assert.deepEqual(await response.json(), {
    contentEncoding: null,
    declaredContentLength: "1000000",
    firstOctet: 0,
    lastOctet: 15,
    receivedByteLength: 1_000_000,
    receivedSha256: "2c030d49ec131bfbbb446ad21e7a2f12cdb4f2f4f3fda3ac709dd2e68a4646c7",
  });
  assert.deepEqual(call.background, ["request-body-limit-invoked"]);
});
