const SECRET_SENTINEL = "EC_WEB_SECRET_MUST_NOT_LEAK";

function json(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default function handler(context) {
  const url = new URL(context.request.url);
  switch (url.pathname) {
    case "/sync":
      return new Response("edge-canon-sync");
    case "/context": {
      context.waitUntil(context.env.EVIDENCE.record("background-complete"));
      return Promise.resolve(
        json({
          contextKeys: Object.keys(context).sort(),
          environment: context.env.TEST_VALUE,
          parameter: context.params.name,
        }),
      );
    }
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
    default:
      return new Response("not found", { status: 404 });
  }
}
