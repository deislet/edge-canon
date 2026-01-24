# Edge Canon Specification v0.1.0

> The authoritative specification for universal edge functions.
> **Write Once, Run Anywhere**: Cloudflare Workers, Deno Deploy, Tencent EdgeOne, **Deislet**.
> [中文版](./SPECIFICATION.zh.md)

---

## 📚 规范文档组织

为了更清晰地区分必需特性和可选特性，本规范已拆分为三个文档：

- **[核心规范 (Core)](./SPECIFICATION_CORE.md)**: 所有平台必须支持的基础能力
  - HTTP Handler、Request/Response、环境变量、路由、日志等
  - 保证：遵循核心规范的代码可在任何 Edge Canon 兼容平台运行

- **[扩展规范 (Extended)](./SPECIFICATION_EXT.md)**: 可选的增强特性
  - KV 存储、SQL 数据库、对象存储、消息队列、WebSocket、Cron 任务等
  - 编译时验证：编译器会检查目标平台是否支持使用的扩展特性

- **[平台支持矩阵 (Platform Matrix)](./PLATFORM_MATRIX.md)**: 各平台的详细兼容性信息
  - 完整的特性支持表
  - 平台限制说明
  - 替代方案建议

**本文档**作为完整参考保留，但推荐优先阅读核心规范和扩展规范。

---

## 1. Project Structure

### 1.1 Directory Layout

```
my-edge-app/
├── functions/                    # Core function logic (Required)
│   ├── index.ts                  # Entry point (Route: /)
│   ├── hello.ts                  # Route: /hello
│   ├── api/
│   │   ├── index.ts              # Route: /api
│   │   ├── users.ts              # Route: /api/users
│   │   ├── posts/
│   │   │   ├── index.ts          # Route: /api/posts
│   │   │   └── [id].ts           # Route: /api/posts/:id (Dynamic)
│   │   └── [[catch]].ts          # Route: /api/* (Catch-all)
│   └── middleware.ts             # Global Middleware (Optional)
├── .config.json                  # Canonical Manifest (Required)
├── .env                          # Local Environment Variables
├── .env.production               # Production Environment Variables
├── package.json                  # Metadata (Optional)
└── README.md                     # Documentation
```

### 1.2 Configuration (`.config.json`)

See [schemas/config.schema.json](../schemas/config.schema.json) for formal definition.

```json
{
  "version": "0.1.0",
  "name": "my-edge-app",
  "runtime": "standard-v1",
  "entryPoint": "functions/index.ts",
  "services": {
    "kv": { "enabled": true, "binding": "KV_STORE" },
    "database": { "enabled": true, "binding": "DB" }
  },
  "vendors": {
    "cloudflare": { "enabled": true },
    "deno": { "enabled": true },
    "tencent": { "enabled": true }
  }
}
```

### 1.3 Configuration Reference Table

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `version` | string | **Required** | Spec version (e.g., "0.1.0") |
| `name` | string | **Required** | Project name (kebab-case) |
| `runtime` | string | `"standard-v1"` | Target runtime environment |
| `language` | string | `"typescript"` | Source language ("typescript" or "javascript") |
| `entryPoint` | string | **Required** | Main entry file (e.g., "functions/index.ts") |
| `functionRoot` | string | `"./functions"` | Root directory for filesystem routing |
| `routing.caseSensitive` | boolean | `false` | Case sensitivity for routes |
| `routing.dynamicParamPattern` | string | `"[param]"` | Pattern for dynamic segments |
| `routing.catchAllPattern` | string | `"[[catchall]]"` | Pattern for catch-all segments |
| `build.outDir` | string | `"./dist"` | Output directory for build artifacts |
| `build.minify` | boolean | `true` | Enable code minification |
| `build.sourceMap` | boolean | `false` | Generate source maps |

---

## 2. Core Principles

### 2.1 Mandatory Rules

1.  **No Platform-Specific Code**:
    *   Forbidden: `if (isCloudflare) { ... }`
    *   Forbidden: Conditional imports based on platform.
    *   Forbidden: Accessing global `Deno` or `caches.default` directly.

2.  **Universal Interfaces Only**:
    *   Developers must use the canonical `Context` interface.
    *   The compiler (`deforge`) handles platform adaptation.

3.  **Compile-Time Negotiation**:
    *   Unsupported features are rejected at compile time.

### 2.2 Forbidden Patterns

```typescript
// ❌ Forbidden: Platform detection
if (typeof Deno !== 'undefined') { }

// ❌ Forbidden: Conditional import
const kv = import(isCloudflare ? '@cloudflare/kv' : '@deno/kv');

// ❌ Forbidden: Direct API access
const cfKV = env.MY_KV_NAMESPACE;
```

### 2.3 Recommended Pattern

```typescript
// ✅ Universal Interface
export default async function handler(context: Context): Promise<Response> {
  const kv = context.services.kv;
  const value = await kv.get('mykey');
  return new Response(value || 'not found');
}
```

---

## 3. Handler Interface

### 3.1 Standard Export

All functions must export a standard HTTP handler. Two styles are supported:

#### Style 1: Default Export (Recommended)

```typescript
export default async function handler(
  context: Context
): Promise<Response> {
  return new Response('Hello World', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });
}
```

#### Style 2: Named Exports (Optional)

```typescript
export async function onRequest(context: Context): Promise<Response> {
  return new Response('Hello World');
}

export async function onRequestGet(context: Context): Promise<Response> {
  return new Response('GET response');
}
```

### 3.2 Strict Policy on Exports

To avoid ambiguity, it is recommended to use **Strict Mode**, which forbids mixing export styles in a single file.

If both `default export` and `onRequest` are detected, the compiler will prioritize **`default export`** for HTTP handling. Named exports `scheduled` and `queue` are permitted alongside the default export.

### 3.3 The Context Object

```typescript
interface Context {
  request: Request;           // Standard Fetch API Request
  env: Record<string, string>; // Environment Variables
  params: Record<string, string>; // Route Parameters
  
  // Service Bindings
  services: {
    kv?: KVStore;
    database?: Database;
    blob?: BlobStore;
    queue?: Queue;
  };

  // Observability
  log: Logger;
  
  // Lifecycle
  waitUntil(promise: Promise<any>): void;
}
```

### 3.4 Trigger Handlers (Async Events)

In addition to the HTTP handler, functions may export handlers for asynchronous triggers.

#### Scheduled Handler (Cron)

```typescript
export async function scheduled(
  event: ScheduledEvent,
  env: Record<string, string>,
  context: Context
): Promise<void> {
  console.log("Cron triggered:", event.cron);
}

interface ScheduledEvent {
  scheduledTime: number; // Unix timestamp
  cron: string;          // Cron expression
}
```

#### Queue Handler

```typescript
export async function queue(
  batch: MessageBatch,
  env: Record<string, string>,
  context: Context
): Promise<void> {
  for (const msg of batch.messages) {
    console.log("Received:", msg.body);
    msg.ack();
  }
}

interface MessageBatch {
  queue: string;
  messages: Message[];
  ackAll(): void;
}

interface Message {
  id: string;
  body: any; // JSON object or string
  timestamp: number;
  ack(): void;
  retry(): void;
}
```

---

## 4. Basic Examples

### Example 1: Minimal Hello World

```typescript
export default async function handler(context: Context) {
  return new Response("Hello World");
}
```

---

## 5. Routing

### 5.1 Automatic Routing

The directory structure maps directly to HTTP routes:

| File Path | Route | Description |
|-----------|-------|-------------|
| `functions/index.ts` | `/` | Root |
| `functions/api/users.ts` | `/api/users` | Nested |
| `functions/users/[id].ts` | `/users/:id` | Dynamic Param |
| `functions/api/[[catch]].ts` | `/api/*` | Catch-all |

### 5.2 Dynamic Syntax

- `[param]` → Single dynamic segment
- `[[catchall]]` → Catch-all remaining path

---

## 6. Environment Variables

### 6.1 Definition

All variables MUST be declared in `.config.json` (Explicit Declaration Principle). Undeclared variables will be ignored during deployment.

```json
{
  "environment": {
    "variables": { "LOG_LEVEL": "info" },
    "secrets": ["API_KEY"]
  }
}
```

### 6.2 Development vs Production

- **Local Dev**: Values are loaded from `.env` file (not committed to git).
- **Production**: Secrets are injected via CLI or platform dashboard.

### 6.3 Access

```typescript
const apiKey = context.env.API_KEY;
```

---

## 7. Storage & Integration Services (KV, DB, Cache, Blob, Queue)

### 7.1 Unified Service Layer

The spec provides **fully unified interfaces** for value-added services.

### 7.2 KV Store Interface

```typescript
interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

### 7.3 Database Interface

```typescript
interface Database {
  query<T>(sql: string, params?: any[]): Promise<T[]>;
  execute(sql: string, params?: any[]): Promise<ExecuteResult>;
  transaction<T>(callback: (tx: Database) => Promise<T>): Promise<T>;
}
```

### 7.4 BlobStore Interface

```typescript
interface BlobStore {
  get(key: string): Promise<BlobObject | null>;
  put(key: string, data: ReadableStream | string): Promise<BlobObject>;
  delete(key: string): Promise<void>;
}
```

### 7.5 Queue Interface

```typescript
interface Queue {
  send(message: any): Promise<void>;
}

### 7.6 Cache Interface (Subset)

```typescript
interface Cache {
  put(request: Request | string, response: Response): Promise<void>;
  match(request: Request | string): Promise<Response | undefined>;
  delete(request: Request | string): Promise<boolean>;
}
```

### 7.7 Compatibility Matrix

**重要**: 完整的平台兼容性信息已移至 **[PLATFORM_MATRIX.md](./PLATFORM_MATRIX.md)**

下表为快速参考：

| Feature | Cloudflare | Deno Deploy | Tencent EdgeOne | Deislet |
|---------|-----------|-------------|-----------------|---------|
| **核心特性** | | | | |
| HTTP Handler | ✅ | ✅ | ✅ | ✅ |
| Request/Response | ✅ | ✅ | ✅ | ✅ |
| Environment Variables | ✅ | ✅ | ✅ | ✅ |
| **扩展特性** | | | | |
| KV Storage | ✅ | ✅ | ✅ | ✅ |
| SQL Database | ✅ D1 | ✅ Postgres | ❌ | ✅ Remote |
| Object Storage | ✅ R2 | ❌ | ❌ | ✅ Remote |
| Cache API | ✅ | ✅ | ✅ | ✅ |
| Cron Jobs | ✅ | ✅ | ❌ | ✅ |
| WebSockets | ✅ | ✅ | ❌ | ✅ |
| Message Queues | ✅ | ❌ | ❌ | ✅ |

详细信息和替代方案请参阅 [平台支持矩阵](./PLATFORM_MATRIX.md)

---

## 8. WebSocket Support

Edge Canon provides standard support for both WebSocket clients and servers (handling upgrade requests).

### 8.1 WebSocket Client

Use the standard `WebSocket` API to connect to external services.

```typescript
const socket = new WebSocket("wss://echo.websocket.org");
socket.onmessage = (event) => console.log(event.data);
socket.send("Hello");
```

### 8.2 WebSocket Server (Upgrade)

To accept a WebSocket connection, respond with a `101 Switching Protocols` status and a `webSocket` option. We recommend using the `WebSocketPair` pattern for better platform compatibility (similar to Cloudflare).

```typescript
export default async function handler(context: Context) {
  if (context.request.headers.get("Upgrade") === "websocket") {
    const { 0: client, 1: server } = new WebSocketPair();
    
    server.accept();
    server.addEventListener("message", (event) => {
      server.send(`Echo: ${event.data}`);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
  return new Response("Expected WebSocket", { status: 426 });
}
```

---

## 9. WebAssembly (Wasm) Support

Edge Canon treats WebAssembly as a first-class citizen for high-performance compute tasks.

### 9.1 Import & Instantiation

`.wasm` files are imported as ES modules. The import exports a `WebAssembly.Module` object (not an instance), allowing developers to control instantiation.

```typescript
// functions/utils/math.wasm
import mathModule from './math.wasm';

export default async function handler(context: Context) {
  // 1. Define imports (if the Wasm module needs them)
  const importObject = {
    env: {
      log: (arg) => console.log(arg)
    }
  };

  // 2. Instantiate
  const instance = await WebAssembly.instantiate(mathModule, importObject);
  
  // 3. Call exports
  const result = instance.exports.add(10, 20);
  return new Response(`Result: ${result}`);
}
```

### 9.2 Constraints & Guidelines

*   **Size Limit**: Wasm binaries should be kept under **1MB** to ensure fast cold starts.
*   **WASI Support**: Currently **Experimental**. It is recommended to use `wasm32-unknown-unknown` target (pure computation without system calls).
*   **Memory**: Wasm memory is part of the isolate's total memory limit (128MB).
*   **Synchronous Execution**: Wasm functions are executed synchronously and will block the main thread. Avoid long-running loops.

---

## 10. Local Development & Testing

```bash
denictl dev
denictl test
```

---

## 11. Build & Deploy

```bash
denictl build
denictl validate
denictl deploy
```

---

## 12. Error Handling

### 12.1 Standard JSON Error Format

All APIs SHOULD return errors in a consistent JSON format to allow clients to handle them programmatically.

```typescript
interface ErrorResponse {
  error: {
    code: string;              // Machine-readable error code (UPPER_CASE)
    message: string;           // Human-readable description
    requestId?: string;        // Trace ID for debugging
    details?: any;             // Optional structured data
  };
}
```

### 12.2 Standard Error Codes

Common error codes used by the platform and recommended for applications:

| Code | HTTP Status | Description |
| :--- | :--- | :--- |
| `INVALID_REQUEST` | 400 | The request parameters are missing or invalid. |
| `UNAUTHORIZED` | 401 | Authentication failed or missing. |
| `FORBIDDEN` | 403 | Authenticated but not authorized to access resource. |
| `NOT_FOUND` | 404 | Resource does not exist. |
| `RESOURCE_EXHAUSTED` | 429 | Rate limit exceeded or quota used up. |
| `INTERNAL_ERROR` | 500 | Unhandled exception or internal platform error. |
| `TIMEOUT` | 504 | Execution time exceeded limit. |

### 12.3 Uncaught Exceptions

If a handler throws an uncaught exception:
1. The platform catches it.
2. Returns a **500 Internal Server Error**.
3. Logs the stack trace to the system log (accessible via `denictl logs`).
4. The user receives a generic error message (stack traces are **never** leaked to the client in production).

---

## 13. Performance & Limits

### 13.1 General Limits

- **Max Execution**: 30s
- **Max Payload**: 50MB

### 13.2 Metrics & Logging

Edge Canon adopts a **"Log-based Metrics"** strategy. Developers emit structured JSON logs via `context.log`, and the platform automatically extracts metrics from them. No external metrics SDK is required.

#### Interface Definition

```typescript
interface Logger {
  debug(msg: string | LogEvent): void;
  info(msg: string | LogEvent): void;
  warn(msg: string | LogEvent): void;
  error(msg: string | LogEvent): void;
}

interface LogEvent {
  message: string;             // Human-readable message
  [key: string]: any;          // Arbitrary context (e.g., user_id)
  
  // Optional: Embedded Metric Definition
  metric?: {
    name: string;              // Metric name (e.g., 'payment_success')
    value: number;             // Metric value
    type: 'counter' | 'gauge' | 'histogram';
    unit?: string;             // e.g., 'ms', 'bytes', 'count'
    tags?: Record<string, string>; // Dimensions for filtering
  };
}
```

#### Examples

**1. Counter (e.g., Count events)**

```typescript
context.log.info({
  message: "Order placed successfully",
  orderId: "ord_123",
  metric: {
    name: "order_count",
    type: "counter",
    value: 1,
    tags: { region: "us-east" }
  }
});
```

**2. Histogram (e.g., Measure duration)**

```typescript
const start = Date.now();
await processImage();
const duration = Date.now() - start;

context.log.info({
  message: "Image processed",
  metric: {
    name: "process_duration",
    type: "histogram",
    value: duration,
    unit: "ms"
  }
});
```

---

## 14. CLI Reference

Refer to `denictl --help`.

---

## 15. Versioning

- **Spec Version**: 0.1.0
- **Release Date**: TBD

---

## 16. Appendix: Core Guarantees

1. **Universal Code**
2. **Write Once, Deploy Anywhere**
3. **Zero Platform Leakage**
4. **Maintainability**

---

*This document is the law. Any implementation claiming "Edge Canon Compliance" must adhere to these interfaces.*
