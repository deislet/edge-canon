import { runCpuWorkload } from "./cpu-workload.mjs";

const SECRET_SENTINEL = "EC_WEB_SECRET_MUST_NOT_LEAK";
const encoder = new TextEncoder();
const seenContexts = new WeakSet();
let moduleInvocationCounter = 0;
let closedWaitUntil;

function json(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function boundedInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum
    ? parsed
    : fallback;
}

function controlledOrigin(context, name) {
  const value = context.env[name];
  if (typeof value !== "string") throw new TypeError(`${name} must be a URL string`);
  const origin = new URL(value);
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    throw new TypeError(`${name} must use HTTP(S)`);
  }
  return origin;
}

export default function handler(context) {
  const url = new URL(context.request.url);
  switch (url.pathname) {
    case "/sync":
      return new Response("edge-canon-sync");
    case "/context": {
      const contextObjectIdentityUnique = !seenContexts.has(context);
      seenContexts.add(context);
      context.waitUntil(context.env.EVIDENCE.record("background-complete"));
      return Promise.resolve(
        json({
          contextKeys: Object.keys(context).sort(),
          contextObjectIdentityUnique,
          environment: context.env.TEST_VALUE,
          parameter: context.params.name,
        }),
      );
    }
    case "/transport-headers":
      return json({
        evidenceMode: context.request.headers.get("x-edge-canon-evidence-mode"),
        evidenceToken: context.request.headers.get("x-edge-canon-evidence-token"),
        invocationId: context.request.headers.get("x-edge-canon-invocation-id"),
      });
    case "/method":
      return context.request.text().then((body) =>
        new Response(`${context.request.method}:${body}`),
      );
    case "/throw-sync":
      throw new Error(SECRET_SENTINEL);
    case "/throw-async":
      return Promise.reject(new Error(SECRET_SENTINEL));
    case "/invalid-undefined":
      return undefined;
    case "/invalid-string":
      return "not a response";
    case "/invalid-object":
      return { status: 200, body: "not a response" };
    case "/concurrent": {
      const marker = url.searchParams.get("marker") ?? "missing-marker";
      const delayMs = boundedInteger(url.searchParams.get("delay"), 0, 5_000);
      const contextObjectIdentityUnique = !seenContexts.has(context);
      seenContexts.add(context);
      moduleInvocationCounter += 1;
      const moduleCounterSample = moduleInvocationCounter;
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(json({ marker, contextObjectIdentityUnique, moduleCounterSample }));
        }, delayMs);
      });
    }
    case "/stream":
      return new Response(
        new ReadableStream({
          async start(controller) {
            for (const chunk of ["stream-one", "stream-two", "stream-three"]) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
          },
        }),
      );
    case "/background": {
      context.waitUntil(
        Promise.resolve().then(() => context.env.EVIDENCE.record("background-first")),
      );
      context.waitUntil(Promise.reject(new Error("EC_BACKGROUND_REJECTION_SENTINEL")));
      context.waitUntil(
        Promise.resolve().then(() => context.env.EVIDENCE.record("background-third")),
      );
      return new Response("background-response");
    }
    case "/capture-wait-until":
      closedWaitUntil = context.waitUntil.bind(context);
      context.waitUntil(new Promise((resolve) => {
        setTimeout(() => {
          try {
            closedWaitUntil(Promise.resolve("late-registration"));
            context.env.EVIDENCE.record("late-wait-until:none:none").finally(resolve);
          } catch (error) {
            context.env.EVIDENCE.record(
              `late-wait-until:${error?.name ?? typeof error}:${error?.code ?? "none"}`,
            ).finally(resolve);
          }
        }, 20);
      }));
      return new Response("wait-until-captured");
    case "/late-wait-until": {
      if (!closedWaitUntil) return new Response("no prior lifecycle", { status: 409 });
      try {
        closedWaitUntil(Promise.resolve("late-registration"));
        return json({ exceptionType: null, failureCode: null });
      } catch (error) {
        return json({
          exceptionType: error?.name ?? typeof error,
          failureCode: error?.code ?? null,
        });
      }
    }
    case "/disconnect": {
      const marker = url.searchParams.get("marker") ?? "disconnect-marker";
      context.env.EVIDENCE.record(`invocation:${marker}`);
      context.waitUntil(
        Promise.resolve().then(() => context.env.EVIDENCE.record(`background:${marker}`)),
      );
      let timer;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`first:${marker}`));
            timer = setTimeout(() => {
              controller.enqueue(encoder.encode(`second:${marker}`));
              controller.close();
            }, 250);
          },
          cancel() {
            clearTimeout(timer);
            return context.env.EVIDENCE.record(`body-cancelled:${marker}`);
          },
        }),
      );
    }
    case "/probe":
      return new Response(`probe:${url.searchParams.get("marker") ?? "probe-marker"}`);
    case "/cpu": {
      const iterations = boundedInteger(context.env.CPU_ITERATIONS, 1, 100_000_000);
      const checksum = runCpuWorkload(iterations);
      return json({ completionSentinel: "cpu-work-complete", checksum });
    }
    case "/subrequests": {
      const origin = controlledOrigin(context, "CONTROLLED_ORIGIN");
      return (async () => {
        for (let index = 0; index < 48; index += 1) {
          const response = await fetch(new URL(`/direct/${index}`, origin));
          if (!response.ok) throw new Error(`controlled direct request ${index} failed`);
        }
        const redirected = await fetch(new URL("/redirect-once", origin));
        if (!redirected.ok) throw new Error("controlled redirect request failed");
        return json({ completionSentinel: "fifty-subrequests-complete", fetchCallCount: 49 });
      })();
    }
    case "/connections": {
      const origin = controlledOrigin(context, "CONNECTION_BARRIER_ORIGIN");
      return Promise.all(
        Array.from({ length: 7 }, (_, index) => fetch(new URL(`/slot/${index}`, origin))),
      ).then(async (responses) => {
        const markers = await Promise.all(responses.map((response) => response.text()));
        return json({ markers });
      });
    }
    case "/request-body-limit":
      return (async () => {
        await context.env.EVIDENCE.record("request-body-limit-invoked");
        const body = await context.request.arrayBuffer();
        const bytes = new Uint8Array(body);
        const digest = await crypto.subtle.digest("SHA-256", body);
        const receivedSha256 = Array.from(new Uint8Array(digest), (value) =>
          value.toString(16).padStart(2, "0")
        ).join("");
        return json({
          contentEncoding: context.request.headers.get("content-encoding"),
          declaredContentLength: context.request.headers.get("content-length"),
          firstOctet: bytes[0] ?? null,
          lastOctet: bytes.at(-1) ?? null,
          receivedByteLength: bytes.byteLength,
          receivedSha256,
        });
      })();
    default:
      return new Response("not found", { status: 404 });
  }
}
