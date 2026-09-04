import crypto from "node:crypto";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function fixtureFiles(marker = "base") {
  return new Map([
    ["static/index.html", { type: "file", bytes: Buffer.from(`<h1>index-${marker}</h1>\n`) }],
    ["static/about.html", { type: "file", bytes: Buffer.from(`<h1>about-${marker}</h1>\n`) }],
    ["static/same.txt", { type: "file", bytes: Buffer.from(`asset-${marker}\n`) }],
    ["static/404.html", { type: "file", bytes: Buffer.from(`<h1>not-found-${marker}</h1>\n`) }],
  ]);
}

export function fixtureDocument(standardVersion, options = {}) {
  const files = options.files ?? fixtureFiles(options.marker);
  const mediaTypes = new Map([
    ["static/index.html", "text/html; charset=utf-8"],
    ["static/about.html", "text/html; charset=utf-8"],
    ["static/same.txt", "text/plain; charset=utf-8"],
    ["static/404.html", "text/html; charset=utf-8"],
  ]);
  const urlByPath = new Map([
    ["static/index.html", "/"],
    ["static/about.html", "/about"],
    ["static/same.txt", "/same"],
    ["static/404.html", "/not-found-page"],
  ]);
  const assets = [...files.entries()].filter(([, file]) => file.type === "file").map(([filePath, file]) => ({
    urlPath: urlByPath.get(filePath) ?? `/${filePath}`,
    filePath,
    size: file.bytes.byteLength,
    sha256: sha256(file.bytes),
    mediaType: mediaTypes.get(filePath) ?? "application/octet-stream",
  })).sort((left, right) => Buffer.compare(Buffer.from(left.urlPath), Buffer.from(right.urlPath)));
  return {
    $schema: "https://github.com/deislet/edge-canon/schemas/routing-static-assets.schema.json",
    schemaVersion: 1,
    format: "edge-canon.routing-static-assets/v1",
    standardVersion,
    matching: {
      input: "normalized-url-pathname",
      caseSensitive: true,
      query: "excluded-from-match",
      rewritePasses: 1,
      assetFunctionPrecedence: "asset-first",
    },
    assets,
    redirects: [
      { id: "old-first", source: "/old/:id", destination: { kind: "path", value: "/new/:id" }, status: 301, query: "preserve" },
      { id: "old-second", source: "/old/:id", destination: { kind: "path", value: "/ignored/:id" }, status: 302, query: "discard" },
      { id: "external-docs", source: "/docs", destination: { kind: "https", value: "https://docs.example.test/guide" }, status: 302, query: "discard" },
    ],
    rewrites: [
      { id: "legacy-api", source: "/legacy/:id", destination: "/api/:id", query: "preserve" },
      { id: "would-chain", source: "/api/:id", destination: "/second/:id", query: "discard" },
    ],
    headers: [
      { id: "all-static", source: "/*", values: [{ name: "Cache-Control", value: "public, max-age=60" }, { name: "X-Route", value: "first" }] },
      { id: "same-second", source: "/same", values: [{ name: "X-Route", value: "second" }] },
    ],
    functions: [
      { id: "same-function", source: "/same", methods: ["*"], entrypointId: "same-handler" },
      { id: "api-function", source: "/api/:id", methods: ["*"], entrypointId: "api-handler" },
      { id: "files-function", source: "/files/*", methods: ["GET"], entrypointId: "files-handler" },
    ],
    fallback: options.fallback ?? { kind: "not-found" },
  };
}

export function capacityDocument(standardVersion) {
  const files = fixtureFiles();
  const document = fixtureDocument(standardVersion, { files });
  document.redirects = Array.from({ length: 50 }, (_, index) => {
    const source = index === 49 ? `/${"a".repeat(499)}` : `/redirect-${index}`;
    const destination = index === 49 ? `/${"b".repeat(499)}` : `/target-${index}`;
    return { id: `redirect-${index}`, source, destination: { kind: "path", value: destination }, status: 302, query: "discard" };
  });
  document.rewrites = Array.from({ length: 50 }, (_, index) => ({
    id: `rewrite-${index}`, source: `/rewrite-${index}`, destination: index === 49 ? `/${"c".repeat(499)}` : "/same", query: "discard",
  }));
  document.headers = Array.from({ length: 30 }, (_, index) => ({
    id: `headers-${index}`,
    source: `/header-${index}`,
    values: Array.from({ length: 30 }, (__, headerIndex) => ({ name: `X-H${headerIndex}`, value: `value-${index}-${headerIndex}` })),
  }));
  document.headers[29].values[29] = { name: `X${"H".repeat(99)}`, value: "v".repeat(1000) };
  return { document, files };
}
