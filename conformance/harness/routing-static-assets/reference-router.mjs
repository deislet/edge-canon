import crypto from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/;
const EXACT_VERSION = /^edge-canon\.next@[0-9a-f]{40}$/;
const RULE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const METHOD = /^(?:\*|[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31})$/;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,99}$/;
const WINDOWS_DEVICES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const FORBIDDEN_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
  "location", "set-cookie", "server",
]);
const ROOT_KEYS = ["schemaVersion", "format", "standardVersion", "matching", "assets", "redirects", "rewrites", "headers", "functions", "fallback"];

export class RoutingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoutingError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RoutingError(code, message);
}

function requireValue(condition, code, message) {
  if (!condition) fail(code, message);
}

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code = "EC_ROUTING_DOCUMENT_INVALID", allowSchema = false) {
  requireValue(object(value), code, "routing object is invalid");
  const actual = Object.keys(value).filter((key) => !(allowSchema && key === "$schema")).sort();
  requireValue(JSON.stringify(actual) === JSON.stringify([...keys].sort()), code, "routing fields are invalid");
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function portableFilePath(value) {
  requireValue(typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 1024, "EC_ROUTING_ASSET_PATH_INVALID", "asset path is invalid");
  requireValue(value === value.normalize("NFC") && !value.startsWith("/") && !value.includes("\\"), "EC_ROUTING_ASSET_PATH_INVALID", "asset path is invalid");
  const segments = value.split("/");
  requireValue(segments.every((segment) => segment && segment !== "." && segment !== ".." && !/[\u0000-\u001f\u007f:*?"<>|]/u.test(segment) && !/[. ]$/u.test(segment) && !WINDOWS_DEVICES.test(segment)), "EC_ROUTING_ASSET_PATH_INVALID", "asset path is invalid");
}

function normalizePercent(segment) {
  requireValue(!/%(?![0-9A-Fa-f]{2})/u.test(segment), "EC_ROUTING_PATH_INVALID", "request pathname is invalid");
  requireValue(!/%(?:00|2f|5c)/iu.test(segment), "EC_ROUTING_PATH_INVALID", "request pathname is invalid");
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    fail("EC_ROUTING_PATH_INVALID", "request pathname is invalid");
  }
  requireValue(decoded !== "." && decoded !== ".." && !decoded.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(decoded), "EC_ROUTING_PATH_INVALID", "request pathname is invalid");
  return decoded;
}

export function normalizePathname(value) {
  requireValue(typeof value === "string" && value.startsWith("/") && !value.includes("?") && !value.includes("#") && !value.includes("\\"), "EC_ROUTING_PATH_INVALID", "request pathname is invalid");
  const rawSegments = value === "/" ? [] : value.slice(1).split("/");
  requireValue(rawSegments.every((segment) => segment.length > 0), "EC_ROUTING_PATH_INVALID", "request pathname is invalid");
  const segments = rawSegments.map(normalizePercent);
  return { pathname: segments.length ? `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}` : "/", segments };
}

function compilePattern(source) {
  requireValue(typeof source === "string" && source.startsWith("/") && source.length <= 500 && /^[\x20-\x7e]+$/.test(source) && !/[?#\\]/u.test(source), "EC_ROUTING_PATTERN_INVALID", "route pattern is invalid");
  const rawSegments = source === "/" ? [] : source.slice(1).split("/");
  requireValue(rawSegments.every((segment) => segment.length > 0), "EC_ROUTING_PATTERN_INVALID", "route pattern is invalid");
  const names = new Set();
  const segments = rawSegments.map((segment, index) => {
    if (segment === "*") {
      requireValue(index === rawSegments.length - 1, "EC_ROUTING_PATTERN_INVALID", "route wildcard must be final");
      return { kind: "splat" };
    }
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      requireValue(/^[A-Za-z][A-Za-z0-9_]*$/.test(name) && !names.has(name), "EC_ROUTING_PATTERN_INVALID", "route parameter is invalid");
      names.add(name);
      return { kind: "parameter", name };
    }
    requireValue(!segment.includes(":") && !segment.includes("*"), "EC_ROUTING_PATTERN_INVALID", "route literal is invalid");
    return { kind: "literal", value: normalizePercent(segment) };
  });
  if (segments.at(-1)?.kind === "splat") names.add("splat");
  return { source, segments, names };
}

function matchPattern(pattern, pathValue) {
  const captures = {};
  let index = 0;
  for (const segment of pattern.segments) {
    if (segment.kind === "splat") {
      captures.splat = pathValue.segments.slice(index);
      index = pathValue.segments.length;
      break;
    }
    if (index >= pathValue.segments.length) return null;
    if (segment.kind === "literal" && segment.value !== pathValue.segments[index]) return null;
    if (segment.kind === "parameter") captures[segment.name] = pathValue.segments[index];
    index += 1;
  }
  return index === pathValue.segments.length ? captures : null;
}

function templateNames(value) {
  return [...value.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
}

function validateTemplate(value, names, external = false) {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= 500 && /^[\x20-\x7e]+$/.test(value) && !/[\r\n]/u.test(value), "EC_ROUTING_DESTINATION_INVALID", "route destination is invalid");
  if (external) {
    const authority = value.slice("https://".length).split("/", 1)[0];
    requireValue(templateNames(authority).length === 0, "EC_ROUTING_DESTINATION_INVALID", "external redirect authority must be literal");
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      fail("EC_ROUTING_DESTINATION_INVALID", "route destination is invalid");
    }
    requireValue(parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && !parsed.hostname.includes(":"), "EC_ROUTING_DESTINATION_INVALID", "external redirect destination is invalid");
  } else {
    requireValue(value.startsWith("/") && !value.includes("?") && !value.includes("#") && !value.includes("\\"), "EC_ROUTING_DESTINATION_INVALID", "route destination is invalid");
  }
  for (const name of templateNames(value)) requireValue(names.has(name), "EC_ROUTING_DESTINATION_INVALID", "route destination references an unknown parameter");
}

function expandTemplate(value, captures) {
  return value.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_, name) => {
    const captured = captures[name];
    return Array.isArray(captured)
      ? captured.map((segment) => encodeURIComponent(segment)).join("/")
      : encodeURIComponent(captured);
  });
}

function validateAssetFiles(assets, assetFiles) {
  requireValue(assetFiles instanceof Map, "EC_ROUTING_ASSET_INVALID", "asset file collection is invalid");
  const urlKeys = new Set();
  const pathKeys = new Map();
  const pathPrefixes = new Map();
  const declaredPaths = new Set();
  for (const asset of assets) {
    exactKeys(asset, ["urlPath", "filePath", "size", "sha256", "mediaType"]);
    const normalized = normalizePathname(asset.urlPath);
    requireValue(normalized.pathname === asset.urlPath, "EC_ROUTING_ASSET_PATH_INVALID", "asset URL is not normalized");
    portableFilePath(asset.filePath);
    requireValue(Number.isSafeInteger(asset.size) && asset.size >= 0 && SHA256.test(asset.sha256) && typeof asset.mediaType === "string" && asset.mediaType.length > 0 && asset.mediaType.length <= 256, "EC_ROUTING_ASSET_INVALID", "asset metadata is invalid");
    requireValue(!urlKeys.has(asset.urlPath), "EC_ROUTING_DUPLICATE", "asset URL is duplicated");
    urlKeys.add(asset.urlPath);
    const folded = asset.filePath.toUpperCase();
    requireValue(!pathKeys.has(folded) || pathKeys.get(folded) === asset.filePath, "EC_ROUTING_DUPLICATE", "asset paths collide");
    pathKeys.set(folded, asset.filePath);
    const segments = asset.filePath.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index + 1).join("/");
      const collisionKey = prefix.normalize("NFC").toUpperCase();
      requireValue(!pathPrefixes.has(collisionKey) || pathPrefixes.get(collisionKey) === prefix, "EC_ROUTING_DUPLICATE", "asset paths collide");
      pathPrefixes.set(collisionKey, prefix);
    }
    declaredPaths.add(asset.filePath);
    const file = assetFiles.get(asset.filePath);
    requireValue(file?.type === "file" && Buffer.isBuffer(file.bytes), "EC_ROUTING_ASSET_INVALID", "asset file is unavailable or unsafe");
    requireValue(file.bytes.byteLength === asset.size && sha256(file.bytes) === asset.sha256, "EC_ROUTING_ASSET_INVALID", "asset content differs from the route document");
  }
  requireValue(assets.every((asset, index) => index === 0 || Buffer.compare(Buffer.from(assets[index - 1].urlPath), Buffer.from(asset.urlPath)) < 0), "EC_ROUTING_DOCUMENT_INVALID", "asset order is invalid");
  requireValue(assetFiles.size === declaredPaths.size && [...assetFiles.keys()].every((value) => declaredPaths.has(value)), "EC_ROUTING_ASSET_INVALID", "asset file collection contains an unlisted file");
}

export function validateRoutingDocument(document, assetFiles, expectedStandardVersion) {
  exactKeys(document, ROOT_KEYS, "EC_ROUTING_DOCUMENT_INVALID", true);
  requireValue(!Object.hasOwn(document, "$schema") || typeof document.$schema === "string", "EC_ROUTING_DOCUMENT_INVALID", "routing schema reference is invalid");
  requireValue(document.schemaVersion === 1 && document.format === "edge-canon.routing-static-assets/v1", "EC_ROUTING_VERSION_UNSUPPORTED", "routing document version is unsupported");
  requireValue(EXACT_VERSION.test(document.standardVersion) && (!expectedStandardVersion || document.standardVersion === expectedStandardVersion), "EC_ROUTING_STANDARD_PIN_INVALID", "routing standard version is not exact");
  exactKeys(document.matching, ["input", "caseSensitive", "query", "rewritePasses", "assetFunctionPrecedence"]);
  requireValue(document.matching.input === "normalized-url-pathname" && document.matching.caseSensitive === true && document.matching.query === "excluded-from-match" && document.matching.rewritePasses === 1 && document.matching.assetFunctionPrecedence === "asset-first", "EC_ROUTING_DOCUMENT_INVALID", "routing matching policy differs");
  for (const key of ["assets", "redirects", "rewrites", "headers", "functions"]) requireValue(Array.isArray(document[key]), "EC_ROUTING_DOCUMENT_INVALID", "routing collection is invalid");
  validateAssetFiles(document.assets, assetFiles);

  const ids = new Set();
  const register = (id) => {
    requireValue(RULE_ID.test(id) && !ids.has(id), "EC_ROUTING_DUPLICATE", "routing rule ID is invalid or duplicated");
    ids.add(id);
  };
  const compiled = { redirects: [], rewrites: [], headers: [], functions: [] };
  for (const rule of document.redirects) {
    exactKeys(rule, ["id", "source", "destination", "status", "query"]);
    exactKeys(rule.destination, ["kind", "value"]);
    register(rule.id);
    const pattern = compilePattern(rule.source);
    requireValue([301, 302].includes(rule.status) && ["preserve", "discard"].includes(rule.query), "EC_ROUTING_DOCUMENT_INVALID", "redirect policy is invalid");
    requireValue(["path", "https"].includes(rule.destination.kind), "EC_ROUTING_DESTINATION_INVALID", "redirect destination kind is invalid");
    validateTemplate(rule.destination.value, pattern.names, rule.destination.kind === "https");
    compiled.redirects.push({ ...rule, pattern });
  }
  for (const rule of document.rewrites) {
    exactKeys(rule, ["id", "source", "destination", "query"]);
    register(rule.id);
    const pattern = compilePattern(rule.source);
    requireValue(["preserve", "discard"].includes(rule.query), "EC_ROUTING_DOCUMENT_INVALID", "rewrite query policy is invalid");
    validateTemplate(rule.destination, pattern.names);
    compiled.rewrites.push({ ...rule, pattern });
  }
  for (const rule of document.headers) {
    exactKeys(rule, ["id", "source", "values"]);
    register(rule.id);
    const pattern = compilePattern(rule.source);
    requireValue(Array.isArray(rule.values) && rule.values.length > 0 && rule.values.length <= 30, "EC_ROUTING_HEADER_INVALID", "header rule is invalid");
    const names = new Set();
    for (const header of rule.values) {
      exactKeys(header, ["name", "value"], "EC_ROUTING_HEADER_INVALID");
      const lower = header.name.toLowerCase();
      requireValue(HEADER_NAME.test(header.name) && !names.has(lower) && !FORBIDDEN_HEADERS.has(lower) && !lower.startsWith("cf-") && !lower.startsWith("x-edgeone-") && !lower.startsWith("eo-"), "EC_ROUTING_HEADER_INVALID", "header name is forbidden or duplicated");
      requireValue(typeof header.value === "string" && header.value.length > 0 && header.value.length <= 1000 && /^[\x20-\x7e]+$/.test(header.value), "EC_ROUTING_HEADER_INVALID", "header value is invalid");
      names.add(lower);
    }
    compiled.headers.push({ ...rule, pattern });
  }
  for (const rule of document.functions) {
    exactKeys(rule, ["id", "source", "methods", "entrypointId"]);
    register(rule.id);
    const pattern = compilePattern(rule.source);
    requireValue(Array.isArray(rule.methods) && rule.methods.length > 0 && new Set(rule.methods).size === rule.methods.length && rule.methods.every((value) => METHOD.test(value)), "EC_ROUTING_DOCUMENT_INVALID", "function methods are invalid");
    requireValue(RULE_ID.test(rule.entrypointId), "EC_ROUTING_DOCUMENT_INVALID", "function entrypoint is invalid");
    compiled.functions.push({ ...rule, pattern });
  }

  exactKeys(document.fallback, document.fallback.kind === "not-found" ? ["kind"] : ["kind", "filePath"]);
  requireValue(["not-found", "custom-404", "spa"].includes(document.fallback.kind), "EC_ROUTING_FALLBACK_INVALID", "fallback kind is invalid");
  if (document.fallback.kind !== "not-found") {
    portableFilePath(document.fallback.filePath);
    requireValue(document.assets.some((asset) => asset.filePath === document.fallback.filePath), "EC_ROUTING_FALLBACK_INVALID", "fallback file is not in the asset index");
  }
  return compiled;
}

function withQuery(destination, queryPolicy, requestQuery) {
  return queryPolicy === "preserve" && requestQuery ? `${destination}?${requestQuery}` : destination;
}

function responseHeaders(document, compiled, originalPath, mediaType, size) {
  const values = [{ name: "Content-Type", value: mediaType }, { name: "Content-Length", value: String(size) }];
  const matched = compiled.headers.find((rule) => matchPattern(rule.pattern, originalPath));
  if (matched) values.push(...matched.values);
  return { values, ruleId: matched?.id ?? null };
}

function assetResponse(document, compiled, assetFiles, asset, originalPath, method, trace, fallbackStatus = 200) {
  const file = assetFiles.get(asset.filePath);
  const headers = responseHeaders(document, compiled, originalPath, asset.mediaType, asset.size);
  return {
    kind: "asset", status: fallbackStatus, location: null, entrypointId: null, params: {},
    headers: headers.values, headerRuleId: headers.ruleId,
    bodySha256: method === "HEAD" ? sha256(Buffer.alloc(0)) : sha256(file.bytes),
    representationSha256: sha256(file.bytes), bodySize: method === "HEAD" ? 0 : file.bytes.byteLength,
    method, trace,
  };
}

export function resolveRequest(document, assetFiles, request, options = {}) {
  const compiled = validateRoutingDocument(document, assetFiles, options.expectedStandardVersion);
  const originalPath = normalizePathname(request.pathname);
  const query = request.query ?? "";
  const method = request.method ?? "GET";
  requireValue(typeof query === "string" && query.length <= 8192 && !/[\r\n#]/u.test(query), "EC_ROUTING_PATH_INVALID", "request query is invalid");
  requireValue(typeof method === "string" && METHOD.test(method) && method !== "*", "EC_ROUTING_PATH_INVALID", "request method is invalid");
  const trace = [];

  for (const rule of compiled.redirects) {
    const captures = matchPattern(rule.pattern, originalPath);
    if (!captures) continue;
    trace.push(`redirect:${rule.id}`);
    return {
      kind: "redirect", status: rule.status,
      location: withQuery(expandTemplate(rule.destination.value, captures), rule.query, query),
      entrypointId: null, params: captures, headers: [], headerRuleId: null,
      bodySha256: sha256(Buffer.alloc(0)), representationSha256: null, bodySize: 0,
      method, routedPathname: null, routedQuery: null,
      requestBodySha256: sha256(request.body ?? Buffer.alloc(0)), trace,
    };
  }

  let routedPath = originalPath;
  let routedQuery = query;
  for (const rule of compiled.rewrites) {
    const captures = matchPattern(rule.pattern, originalPath);
    if (!captures) continue;
    trace.push(`rewrite:${rule.id}`);
    routedPath = normalizePathname(expandTemplate(rule.destination, captures));
    routedQuery = rule.query === "preserve" ? query : "";
    break;
  }
  if (method === "GET" || method === "HEAD") {
    const asset = document.assets.find((value) => value.urlPath === routedPath.pathname);
    if (asset) {
      trace.push("asset");
      return {
        ...assetResponse(document, compiled, assetFiles, asset, originalPath, method, trace),
        routedPathname: routedPath.pathname, routedQuery,
        requestBodySha256: sha256(request.body ?? Buffer.alloc(0)),
      };
    }
  }
  for (const rule of compiled.functions) {
    const captures = matchPattern(rule.pattern, routedPath);
    if (!captures || !(rule.methods.includes("*") || rule.methods.includes(method))) continue;
    trace.push(`function:${rule.id}`);
    return {
      kind: "function", status: 200, location: null, entrypointId: rule.entrypointId,
      params: captures, headers: [], headerRuleId: null, bodySha256: null,
      representationSha256: null, bodySize: null, method,
      routedPathname: routedPath.pathname, routedQuery,
      requestBodySha256: sha256(request.body ?? Buffer.alloc(0)), trace,
    };
  }
  trace.push(`fallback:${document.fallback.kind}`);
  if (document.fallback.kind === "not-found") {
    return {
      kind: "not-found", status: 404, location: null, entrypointId: null, params: {},
      headers: [], headerRuleId: null, bodySha256: sha256(Buffer.alloc(0)),
      representationSha256: sha256(Buffer.alloc(0)), bodySize: 0, method,
      routedPathname: routedPath.pathname, routedQuery,
      requestBodySha256: sha256(request.body ?? Buffer.alloc(0)), trace,
    };
  }
  const asset = document.assets.find((value) => value.filePath === document.fallback.filePath);
  const result = assetResponse(document, compiled, assetFiles, asset, originalPath, method, trace, document.fallback.kind === "spa" ? 200 : 404);
  return {
    ...result, routedPathname: routedPath.pathname, routedQuery,
    requestBodySha256: sha256(request.body ?? Buffer.alloc(0)),
  };
}
