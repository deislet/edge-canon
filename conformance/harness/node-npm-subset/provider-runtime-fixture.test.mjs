import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import handler from "./provider-runtime-fixture.mjs";

test("the deployable EC-NODE fixture executes the shared runtime vectors", async () => {
  const previousShared = process.env.SHARED;
  const previousTenant = process.env.TENANT;
  process.env.SHARED = "initial";
  try {
    const response = await handler({ request: new Request("https://fixture.invalid/?label=A") });
    assert.equal(response.status, 200);
    const document = await response.json();
    assert.deepEqual(document.cases.map(({ id }) => id), [
      "EC-NODE-T001",
      "EC-NODE-T002",
      "EC-NODE-T003",
      "EC-NODE-T004",
      "EC-NODE-T005",
      "EC-NODE-T006",
      "EC-NODE-T007",
    ]);
    const byId = new Map(document.cases.map(({ id, data }) => [id, data]));
    assert.equal(byId.get("EC-NODE-T001").inventory.length, 18);
    assert.ok(byId.get("EC-NODE-T001").inventory.every(({ missing }) => missing.length === 0));
    assert.deepEqual(byId.get("EC-NODE-T002"), {
      utf8: "edge-Canon",
      hex: "656467652d43616e6f6e",
      viewAliases: true,
      assertionError: { name: "AssertionError", code: "ERR_ASSERTION", actual: 1, expected: 2, operator: "deepStrictEqual" },
    });
    assert.equal(byId.get("EC-NODE-T003").digest, "cfa7d671d5f577ea4f8847ef508612bd3af792071334dcf00ffb1dfe57d2489c");
    assert.deepEqual(byId.get("EC-NODE-T004").eventTrace, ["first-7", "second-7"]);
    assert.deepEqual(byId.get("EC-NODE-T005").pathValues, {
      posix: "/a/c",
      win32: "C:\\a\\c",
      relative: "../c/d",
      parsed: { root: "/", dir: "/srv/app", base: "index.mjs", ext: ".mjs", name: "index" },
    });
    assert.deepEqual(byId.get("EC-NODE-T006").streamed, ["EDGE", "CANON"]);
    assert.deepEqual(byId.get("EC-NODE-T007").scheduleOrder, ["callback", "nextTick", "promise", "immediate"]);
    assert.deepEqual(byId.get("EC-NODE-T007"), {
      scheduleOrder: ["callback", "nextTick", "promise", "immediate"],
      contexts: { A: ["A", "A", "A", "A", "A"], B: ["B", "B", "B", "B", "B"] },
      exitLifecycle: { exited: { store: null, sum: 5 }, restored: "outer" },
      storeAfterRun: null,
    });
    assert.equal(document.invocation.label, "A");
    assert.equal(document.invocation.before, "initial");
  } finally {
    if (previousShared === undefined) delete process.env.SHARED;
    else process.env.SHARED = previousShared;
    if (previousTenant === undefined) delete process.env.TENANT;
    else process.env.TENANT = previousTenant;
  }
});

test("the deployable fixture uses only enumerated Node imports", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./provider-runtime-fixture.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /import\s+\*\s+as/);
  assert.doesNotMatch(source, /from\s+["']node:[^"']+["'];?\s*$\n?\s*export\s+default/m);
  assert.doesNotMatch(source, /import\s+[A-Za-z_$][\w$]*\s*(?:,|from)\s*["']node:/);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /\bimport\s*\(/);
});
