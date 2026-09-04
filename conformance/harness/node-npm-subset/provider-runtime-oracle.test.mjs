import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_MODULES } from "./fixture.mjs";
import handler from "./provider-runtime-fixture.mjs";
import { verifyProviderRuntimeResponses } from "./provider-runtime-oracle.mjs";

const PROCESS_FIELDS = ["env", "getBuiltinModule", "nextTick", "platform", "version", "versions"];
const PATH_FIELDS = [...BUILTIN_MODULES["node:path"]].sort();
const URL_FIELDS = [...BUILTIN_MODULES["node:url"]].sort();

async function execute(label) {
  const previousShared = process.env.SHARED;
  const previousTenant = process.env.TENANT;
  process.env.SHARED = "initial";
  delete process.env.TENANT;
  try {
    const response = await handler({ request: new Request(`https://fixture.invalid/?label=${label}`) });
    const document = await response.json();
    for (const item of document.cases[0].data.inventory) item.visible = [...item.exports].sort();
    document.invocation = {
      label,
      before: "initial",
      environment: { TENANT: label, SHARED: label === "A" ? "changed-a" : "initial" },
      version: "v24.20.0",
      nodeVersion: "24.20.0",
      platform: "linux",
      visibleFields: PROCESS_FIELDS,
      hostFieldsHidden: true,
      builtin: {
        pathJoin: "edge/canon",
        pathResolve: "/edge/canon",
        posixResolve: "/edge/canon",
        win32Resolve: "\\edge\\canon",
        pathFields: PATH_FIELDS,
        relativeFileUrl: "file:///asset%20%23%25.txt",
        posixFilePath: "/asset space.txt",
        windowsFilePath: "C:\\asset space.txt",
        urlFields: URL_FIELDS,
        unsupportedIsUndefined: true,
      },
    };
    return document;
  } finally {
    if (previousShared === undefined) delete process.env.SHARED;
    else process.env.SHARED = previousShared;
    if (previousTenant === undefined) delete process.env.TENANT;
    else process.env.TENANT = previousTenant;
  }
}

test("the provider runtime oracle accepts the exact normalized runtime surface", async () => {
  const documents = await Promise.all([execute("A"), execute("B")]);
  assert.deepEqual(verifyProviderRuntimeResponses(documents), {
    suiteId: "EC-NODE",
    status: "runtime-pass",
    runtimeCaseIds: [
      "EC-NODE-T001", "EC-NODE-T002", "EC-NODE-T003", "EC-NODE-T004",
      "EC-NODE-T005", "EC-NODE-T006", "EC-NODE-T007", "EC-NODE-T012",
    ],
  });
});

test("the provider runtime oracle rejects a cross-invocation environment leak", async () => {
  const documents = await Promise.all([execute("A"), execute("B")]);
  documents[1].invocation.environment.SHARED = "changed-a";
  assert.throws(() => verifyProviderRuntimeResponses(documents), /env snapshots crossed/);
});

test("the provider runtime oracle rejects exports outside the capability lock", async () => {
  const documents = await Promise.all([execute("A"), execute("B")]);
  documents[0].cases[0].data.inventory[0].visible.push("vendorExtension");
  assert.throws(() => verifyProviderRuntimeResponses(documents), /fields outside the lock/);
});
