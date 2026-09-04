import crypto from "node:crypto";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { API_BASELINE_DATE, CAPACITY_BODY_BYTE, SHA256_ABC, URL_VECTORS, capabilityLock } from "./fixture.mjs";
import { captureContractFailure, deriveProviderConfiguration, validateCapabilityLock } from "./reference-runtime.mjs";

const CASE_IDS = Array.from({ length: 14 }, (_, index) => `EC-WEBAPI-T${String(index + 1).padStart(3, "0")}`);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function identity(value) {
  return sha256(Buffer.from(JSON.stringify(stable(value)), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function resolveStandardVersion(explicit) {
  if (explicit) return explicit;
  if (process.env.EDGE_CANON_STANDARD_VERSION) return process.env.EDGE_CANON_STANDARD_VERSION;
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: new URL("../../..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return `edge-canon.next@${commit}`;
}

function record(id, data) {
  return { id, observedAt: new Date().toISOString(), data, evidenceRefs: [`local:web-platform-apis/${id}`] };
}

function captureSync(operation) {
  try {
    operation();
    return { settlement: "return", name: null };
  } catch (error) {
    return { settlement: "throw", name: error?.name ?? error?.constructor?.name ?? "Error" };
  }
}

async function captureAsync(operation) {
  try {
    const value = await operation();
    return { settlement: "fulfill", name: null, isResponse: value instanceof Response };
  } catch (error) {
    return { settlement: "reject", name: error?.name ?? error?.constructor?.name ?? "Error", isResponse: false };
  }
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function listen(handler) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(`server failure: ${error.message}`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function withServers(operation) {
  const second = await listen(async (request, response) => {
    const body = await readRequest(request);
    response.writeHead(200, { "content-type": "application/json", "x-server": "second" });
    response.end(JSON.stringify({ method: request.method, url: request.url, headers: request.headers, bodyLength: body.length }));
  });
  const first = await listen(async (request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    if (url.pathname === "/manual" || url.pathname === "/error") {
      response.writeHead(302, { location: "/target" });
      response.end();
      return;
    }
    if (url.pathname === "/post303") {
      await readRequest(request);
      response.writeHead(303, { location: "/echo" });
      response.end();
      return;
    }
    const methodRedirect = /^\/method-redirect\/(301|302|303|307|308)$/.exec(url.pathname);
    if (methodRedirect) {
      await readRequest(request);
      response.writeHead(Number(methodRedirect[1]), { location: "/echo" });
      response.end();
      return;
    }
    if (url.pathname === "/cross") {
      response.writeHead(302, { location: `${second.origin}/capture` });
      response.end();
      return;
    }
    if (url.pathname === "/slow") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (!response.destroyed) response.end("slow");
      return;
    }
    if (url.pathname === "/close") {
      request.socket.destroy();
      return;
    }
    const delayMatch = /^\/delay\/(\d+)$/.exec(url.pathname);
    if (delayMatch) {
      await new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get("ms"))));
      response.writeHead(200, { "content-type": "text/plain", "x-request-id": delayMatch[1] });
      response.end(`body-${delayMatch[1]}`);
      return;
    }
    const body = await readRequest(request);
    if (url.pathname === "/echo") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ method: request.method, bodyLength: body.length, headers: request.headers }));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain", "x-target-path": url.pathname });
    response.end(url.pathname === "/healthy" ? "healthy" : "target");
  });
  try {
    return await operation(first.origin, second.origin);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
}

export async function runSuite(options = {}) {
  const standardVersion = resolveStandardVersion(options.standardVersion);
  if (!/^edge-canon\.next@[0-9a-f]{40}$/.test(standardVersion)) throw new Error("an exact Edge Canon commit is required");
  const lock = capabilityLock(standardVersion);
  validateCapabilityLock(lock, standardVersion);
  const artifactSha256 = identity(lock);
  const cases = [];

  const urls = URL_VECTORS.map((vector) => new URL(vector.input, vector.base).href);
  const query = new URLSearchParams("z=last&a=first&a=second");
  query.append("a", "third value");
  const beforeSort = [...query];
  query.sort();
  cases.push(record(CASE_IDS[0], { urls, expectedUrls: URL_VECTORS.map((value) => value.expected), beforeSort, afterSort: [...query], serializedQuery: query.toString() }));

  const headers = new Headers([["X-Z", "  one\t"], ["x-a", "first"], ["X-A", "second"]]);
  headers.set("X-M", "middle");
  const forEach = [];
  headers.forEach((value, name) => { forEach.push([name, value]); return true; });
  const invalidHeaders = [
    ["space-name", () => new Headers({ "bad header": "value" })],
    ["nul-value", () => new Headers({ x: "a\0b" })],
    ["crlf-value", () => new Headers({ x: "a\r\nb" })],
  ].map(([variant, operation]) => ({ variant, ...captureSync(operation) }));
  cases.push(record(CASE_IDS[1], { entries: [...headers], getCombined: headers.get("x-a"), forEach, invalidHeaders }));

  const controller = new AbortController();
  const request = new Request("https://EXAMPLE.com:443/api?q=1", { method: "post", headers: { "X-Original": "yes" }, body: "payload", redirect: "manual", signal: controller.signal });
  const requestClone = request.clone();
  request.headers.set("X-Original", "changed");
  requestClone.headers.set("X-Clone", "yes");
  const requestBodies = await Promise.all([request.text(), requestClone.text()]);
  const signalInitiallyAborted = request.signal.aborted;
  controller.abort();
  cases.push(record(CASE_IDS[2], {
    properties: {
      url: request.url, method: request.method, redirect: request.redirect,
      signalInitiallyAborted, signalFollowsAbort: request.signal.aborted,
      cloneSignalFollowsAbort: requestClone.signal.aborted,
    },
    originalHeaders: [...request.headers], cloneHeaders: [...requestClone.headers], bodies: requestBodies,
    headerObjectsDistinct: request.headers !== requestClone.headers,
    getBodyError: captureSync(() => new Request("https://example.com", { method: "GET", body: "x" })),
  }));

  const response = new Response("created", { status: 201, statusText: "Created", headers: { "X-Result": "yes" } });
  const redirects = [301, 302, 303, 307, 308].map((status) => {
    const value = Response.redirect("https://EXAMPLE.com:443/next", status);
    return { status: value.status, location: value.headers.get("location") };
  });
  const errorResponse = Response.error();
  cases.push(record(CASE_IDS[3], {
    normal: {
      status: response.status, statusText: response.statusText, ok: response.ok,
      redirected: response.redirected, url: response.url,
      header: response.headers.get("x-result"), body: await response.text(),
    },
    redirects,
    errorResponse: { status: errorResponse.status, ok: errorResponse.ok, body: errorResponse.body },
    invalidConstructor: captureSync(() => new Response(null, { status: 101 })),
    invalidRedirect: captureSync(() => Response.redirect("https://example.com", 200)),
  }));

  const textResponse = new Response("hello");
  const textValue = await textResponse.text();
  const secondRead = await captureAsync(() => textResponse.text());
  const cloneSource = new Response("clone-body");
  const cloneBranch = cloneSource.clone();
  const arrayBufferLength = (await new Response("abc").arrayBuffer()).byteLength;
  const blob = await new Response("blob").blob();
  const jsonValue = await new Response('{"value":7}').json();
  const form = await new Response("a=1&a=2", { headers: { "content-type": "application/x-www-form-urlencoded" } }).formData();
  const invalidJson = await captureAsync(() => new Response("{").json());
  const requestReaderValues = {
    text: await new Request("https://example.com", { method: "POST", body: "request-text" }).text(),
    arrayBufferLength: (await new Request("https://example.com", { method: "POST", body: "abc" }).arrayBuffer()).byteLength,
    blobText: await (await new Request("https://example.com", { method: "POST", body: "request-blob" }).blob()).text(),
    jsonValue: await new Request("https://example.com", { method: "POST", body: '{"request":8}' }).json(),
    formEntries: [...await new Request("https://example.com", { method: "POST", body: "r=1&r=2", headers: { "content-type": "application/x-www-form-urlencoded" } }).formData()],
  };
  cases.push(record(CASE_IDS[4], {
    textValue, bodyUsed: textResponse.bodyUsed, secondRead,
    cloneBodies: await Promise.all([cloneSource.text(), cloneBranch.text()]),
    readers: { arrayBufferLength, blobText: await blob.text(), jsonValue, formEntries: [...form] },
    requestReaders: requestReaderValues, invalidJson,
  }));

  const encoder = new TextEncoder();
  const encoded = encoder.encode("A✓𐍈");
  const encodeTarget = new Uint8Array(8);
  const encodeInto = encoder.encodeInto("✓x", encodeTarget);
  const decoder = new TextDecoder("utf-8");
  const streamFirst = decoder.decode(new Uint8Array([0xe2, 0x9c]), { stream: true });
  const streamSecond = decoder.decode(new Uint8Array([0x93]));
  const replacement = new TextDecoder().decode(new Uint8Array([0xc3, 0x28]));
  const fatalError = captureSync(() => new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xc3, 0x28])));
  const encodedBase64 = btoa("\x00\xffA");
  cases.push(record(CASE_IDS[5], {
    encoding: encoder.encoding,
    decoderProperties: { encoding: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).encoding, fatal: new TextDecoder("utf-8", { fatal: true }).fatal, ignoreBOM: new TextDecoder("utf-8", { ignoreBOM: true }).ignoreBOM },
    encoded: [...encoded], encodeInto, encodeIntoBytes: [...encodeTarget.slice(0, encodeInto.written)],
    decoded: new TextDecoder().decode(encoded), streamParts: [streamFirst, streamSecond], replacement,
    fatalError, base64: { encoded: encodedBase64, decodedCodes: [...atob(` \n${encodedBase64}\t`)].map((value) => value.charCodeAt(0)) },
    invalidBase64: captureSync(() => atob("%%%")), unicodeBtoa: captureSync(() => btoa("✓")),
  }));

  await withServers(async (firstOrigin, secondOrigin) => {
    const abortController = new AbortController();
    let abortEvents = 0;
    abortController.signal.addEventListener("abort", () => { abortEvents += 1; });
    const slowPromise = fetch(`${firstOrigin}/slow`, { signal: abortController.signal });
    const independentPromise = fetch(`${firstOrigin}/healthy`).then((value) => value.text());
    abortController.abort();
    abortController.abort();
    const abortResult = await captureAsync(() => slowPromise);
    const independent = await independentPromise;
    const completedController = new AbortController();
    const completed = await fetch(`${firstOrigin}/healthy`, { signal: completedController.signal }).then((value) => value.text());
    completedController.abort();
    cases.push(record(CASE_IDS[6], { initialAborted: false, finalAborted: abortController.signal.aborted, abortEvents, abortResult, independent, completedAfterLateAbort: completed }));

    const randomTarget = new Uint8Array(32);
    const randomReturn = globalThis.crypto.getRandomValues(randomTarget);
    const uuid = globalThis.crypto.randomUUID();
    const digest = Buffer.from(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"))).toString("hex");
    cases.push(record(CASE_IDS[7], { sameRandomBuffer: randomReturn === randomTarget, randomNonZero: randomTarget.some((value) => value !== 0), uuid, digest, expectedDigest: SHA256_ABC }));

    const manual = await fetch(new Request(`${firstOrigin}/manual`, { redirect: "manual" }));
    const redirectError = await captureAsync(() => fetch(`${firstOrigin}/error`, { redirect: "error" }));
    const postResult = await fetch(`${firstOrigin}/post303`, { method: "POST", body: "post-body", headers: { "content-type": "text/plain" } }).then((value) => value.json());
    const methodResults = [];
    for (const status of [301, 302, 303, 307, 308]) {
      const value = await fetch(`${firstOrigin}/method-redirect/${status}`, { method: "POST", body: "post-body", headers: { "content-type": "text/plain" } }).then((item) => item.json());
      methodResults.push({ status, method: value.method, bodyLength: value.bodyLength, contentType: value.headers["content-type"] ?? null });
    }
    const credentialCanaries = { authorization: "Bearer EC_AUTH_CANARY", cookie: "EC_COOKIE_CANARY=1", "proxy-authorization": "Basic EC_PROXY_CANARY" };
    const crossResponse = await fetch(`${firstOrigin}/cross`, { headers: credentialCanaries });
    const cross = await crossResponse.json();
    cases.push(record(CASE_IDS[8], {
      manual: { status: manual.status, location: manual.headers.get("location"), url: manual.url },
      redirectError, postResult, methodResults,
      crossOrigin: { expectedOrigin: secondOrigin, finalUrl: crossResponse.url, method: cross.method, authorization: cross.headers.authorization ?? null, cookie: cross.headers.cookie ?? null, proxyAuthorization: cross.headers["proxy-authorization"] ?? null },
    }));

    const timerTrace = ["sync"];
    let clearedCount = 0;
    const cleared = setTimeout(() => { clearedCount += 1; }, 5);
    clearTimeout(cleared);
    await new Promise((resolve) => setTimeout(() => { timerTrace.push("timeout"); resolve(); }, 0));
    let intervalCount = 0;
    await new Promise((resolve) => {
      const interval = setInterval(() => {
        intervalCount += 1;
        timerTrace.push(`interval-${intervalCount}`);
        if (intervalCount === 2) { clearInterval(interval); resolve(); }
      }, 1);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    cases.push(record(CASE_IDS[9], { trace: timerTrace, clearedCount, intervalCount }));

    const requests = [
      { id: "1", delay: 60 }, { id: "2", delay: 30 }, { id: "3", delay: 5 },
    ];
    const completionOrder = [];
    const results = await Promise.all(requests.map(async ({ id, delay }) => {
      const value = await fetch(`${firstOrigin}/delay/${id}?ms=${delay}`);
      const result = { requestedId: id, headerId: value.headers.get("x-request-id"), body: await value.text() };
      completionOrder.push(id);
      return result;
    }));
    cases.push(record(CASE_IDS[10], { completionOrder, results }));

    const capacityBody = Buffer.alloc(lock.limits.bodyReaderOctets, CAPACITY_BODY_BYTE);
    const capacityText = capacityBody.toString("ascii");
    const capacityJson = `{"v":"${"x".repeat(lock.limits.bodyReaderOctets - 8)}"}`;
    const capacityForm = `a=${"x".repeat(lock.limits.bodyReaderOctets - 2)}`;
    async function capacityReaders(make) {
      const text = await make(capacityText).text();
      const arrayBuffer = await make(capacityText).arrayBuffer();
      const blobValue = await make(capacityText).blob();
      const json = await make(capacityJson).json();
      const formValue = await make(capacityForm, { "content-type": "application/x-www-form-urlencoded" }).formData();
      return {
        textLength: text.length,
        arrayBufferLength: arrayBuffer.byteLength,
        blobSize: blobValue.size,
        jsonValueLength: json.v.length,
        formValueLength: formValue.get("a").length,
      };
    }
    const responseReaderCapacities = await capacityReaders((body, headers = {}) => new Response(body, { headers }));
    const requestReaderCapacities = await capacityReaders((body, headers = {}) => new Request("https://example.com/capacity", { method: "POST", body, headers }));
    const capacityName = `x-${"n".repeat(lock.limits.headerNameAsciiCharacters - 2)}`;
    const capacityValue = "v".repeat(lock.limits.headerValueAsciiCharacters);
    const capacityHeaders = new Headers({ [capacityName]: capacityValue });
    const maximumRandom = new Uint8Array(lock.limits.randomValuesOctets);
    globalThis.crypto.getRandomValues(maximumRandom);
    const overRandom = captureSync(() => globalThis.crypto.getRandomValues(new Uint8Array(lock.limits.randomValuesOctets + 1)));
    cases.push(record(CASE_IDS[11], {
      body: { length: capacityBody.length, sha256: sha256(capacityBody), expectedSha256: sha256(Buffer.alloc(lock.limits.bodyReaderOctets, CAPACITY_BODY_BYTE)), requestReaderCapacities, responseReaderCapacities },
      header: { nameLength: [...capacityHeaders.keys()][0].length, valueLength: capacityHeaders.get(capacityName).length },
      random: { acceptedLength: maximumRandom.length, overRandom },
    }));

    const networkFailure = await captureAsync(() => fetch(`${firstOrigin}/close`));
    const parseResponse = new Response("not-json");
    const parseFailure = await captureAsync(() => parseResponse.json());
    const healthy = await fetch(`${firstOrigin}/healthy`).then((value) => value.text());
    cases.push(record(CASE_IDS[12], { networkFailure, parseFailure, parseBodyUsed: parseResponse.bodyUsed, healthy }));
  });

  const mutations = [];
  for (const [variant, mutate] of [
    ["higher-major", (value) => { value.format = "edge-canon.web-platform-apis/v2"; value.schemaVersion = 2; }],
    ["floating-standard", (value) => { value.standardVersion = "edge-canon.next@main"; }],
    ["unknown-field", (value) => { value.vendor = "cloudflare"; }],
    ["provider-extension-required", (value) => { value.providerExtensions = "required"; }],
  ]) {
    const value = clone(lock);
    mutate(value);
    mutations.push({ variant, code: captureContractFailure(value, standardVersion), applicationExecutions: 0 });
  }
  const cloudflare = deriveProviderConfiguration(lock, "cloudflare-workers-pages");
  cases.push(record(CASE_IDS[13], {
    baselineDate: API_BASELINE_DATE, mutations, cloudflare,
    requiredApiKeys: Object.keys(lock.apis).sort(), providerExtensionKeys: [],
  }));

  return {
    schemaVersion: 1,
    standardId: "edge-canon.next",
    suiteId: "EC-WEBAPI",
    backend: { id: "edge-canon-reference-webapi", implementationVersion: "edge-canon-reference-webapi-harness/1", standardVersion },
    artifactSha256,
    cases,
  };
}

async function main(outputPath, standardVersion) {
  const document = await runSuite({ standardVersion });
  const output = `${JSON.stringify(document, null, 2)}\n`;
  if (outputPath) {
    const fs = await import("node:fs");
    fs.writeFileSync(outputPath, output);
  } else process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2], process.argv[3]).catch((error) => {
    process.stderr.write(`EC-WEBAPI runner failed: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
