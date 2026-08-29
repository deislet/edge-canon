# Edge Canon Basic Specification v0.1.0

> **基础规范**：所有平台必须支持的基础能力
> **保证**: 遵循此规范的代码可在任何 Edge Canon 兼容平台运行

---

## 1. 核心原则

### 1.1 强制规则

1. **禁止平台特定代码**:
   - ❌ 禁止: `if (isCloudflare) { ... }`
   - ❌ 禁止: 基于平台的条件导入
   - ❌ 禁止: 直接访问平台全局对象 (`Deno`, `caches.default`)

2. **仅使用统一接口**:
   - ✅ 使用标准的 `Context` 接口
   - ✅ 编译器负责平台适配

3. **编译时协商**:
   - 不支持的特性在编译时拒绝

### 1.2 禁止模式

```typescript
// ❌ 禁止: 平台检测
if (typeof Deno !== 'undefined') { }

// ❌ 禁止: 条件导入
const kv = import(isCloudflare ? '@cloudflare/kv' : '@deno/kv');

// ❌ 禁止: 直接访问平台 API
const cfKV = env.MY_KV_NAMESPACE;

// ❌ 禁止: 访问 context.raw
const platformEnv = context.raw.cloudflare.env;
```

### 1.3 推荐模式

```typescript
// ✅ 统一接口
export default async function handler(context: Context): Promise<Response> {
  const apiKey = context.env.API_KEY;
  const userId = context.params.id;

  return new Response(`Hello User ${userId}`);
}
```

---

## 2. 项目结构 (Core)

### 2.1 目录布局

```
my-edge-app/
├── functions/                    # 核心函数逻辑 (必需)
│   ├── index.ts                  # 入口点 (路由: /)
│   ├── hello.ts                  # 路由: /hello
│   └── api/
│       ├── users.ts              # 路由: /api/users
│       └── [id].ts               # 路由: /api/:id (动态路由)
├── .config.json                  # 标准配置 (必需)
└── package.json                  # 元数据 (可选)
```

### 2.2 配置文件 (.config.json)

**最小配置**（仅核心特性）:

```json
{
  "version": "0.1.0",
  "name": "my-edge-app",
  "runtime": "standard-v1",
  "language": "typescript",
  "functionRoot": "./functions"
}
```

**核心配置字段**:

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `version` | string | **必需** | 规范版本 (e.g., "0.1.0") |
| `name` | string | **必需** | 项目名称 (kebab-case) |
| `runtime` | string | `"standard-v1"` | 目标运行时 |
| `language` | string | `"typescript"` | 源语言 ("typescript" 或 "javascript") |
| `functionRoot` | string | `"./functions"` | 函数根目录 |

---

## 3. Handler 接口 (Core)

### 3.1 标准导出

所有函数必须导出标准 HTTP handler。

#### 风格 1: 默认导出（推荐）

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

#### 风格 2: 命名导出（可选）

```typescript
export async function onRequest(context: Context): Promise<Response> {
  return new Response('Hello World');
}
```

### 3.2 基础 Context 对象

```typescript
/**
 * 基础 Context 接口
 * 所有平台必须实现的基础能力
 */
interface Context {
  // ============ HTTP 基础 ============

  /** 标准 Fetch API Request */
  request: Request;

  // ============ 环境与参数 ============

  /** 环境变量 (必须在 .config.json 中声明) */
  env: Record<string, string>;

  /** 路由参数 (e.g., /users/:id → { id: "123" }) */
  params: Record<string, string>;

  // ============ 基础服务 ============

  /** 基础存储服务（所有平台必须支持） */
  services: {
    /** KV 键值存储 */
    kv: KVStore;

    /** HTTP 缓存 */
    cache: Cache;
  };

  // ============ 可观测性 ============

  /** 结构化日志 */
  log: Logger;

  // ============ 生命周期 ============

  /** 后台任务延迟（不阻塞响应） */
  waitUntil(promise: Promise<any>): void;
}
```

### 3.3 Logger 接口

```typescript
interface Logger {
  debug(msg: string | LogEvent): void;
  info(msg: string | LogEvent): void;
  warn(msg: string | LogEvent): void;
  error(msg: string | LogEvent): void;
}

interface LogEvent {
  message: string;
  [key: string]: any;  // 任意上下文数据
}
```

---

## 4. 路由 (Core)

### 4.1 自动路由

目录结构直接映射到 HTTP 路由：

| 文件路径 | 路由 | 说明 |
|---------|------|------|
| `functions/index.ts` | `/` | 根路由 |
| `functions/api/users.ts` | `/api/users` | 嵌套路由 |
| `functions/users/[id].ts` | `/users/:id` | 动态参数 |
| `functions/api/[[catch]].ts` | `/api/*` | Catch-all |

### 4.2 动态路由语法

- `[param]` → 单个动态段
- `[[catchall]]` → 捕获剩余路径

**示例**:

```typescript
// functions/users/[id].ts
export default async function handler(context: Context) {
  const userId = context.params.id;  // 从路由中提取
  return new Response(`User ID: ${userId}`);
}
```

---

## 5. 环境变量 (Core)

### 5.1 声明

所有变量**必须**在 `.config.json` 中声明（显式声明原则）：

```json
{
  "environment": {
    "variables": { "LOG_LEVEL": "info" },
    "secrets": ["API_KEY"]
  }
}
```

### 5.2 开发 vs 生产

- **本地开发**: 从 `.env` 文件加载（不提交到 git）
- **生产环境**: 通过 CLI 或平台控制台注入

### 5.3 访问

```typescript
export default async function handler(context: Context) {
  const apiKey = context.env.API_KEY;
  const logLevel = context.env.LOG_LEVEL;

  return new Response(`Log level: ${logLevel}`);
}
```

---

## 6. KV Storage (Basic)

**所有平台必须支持 KV 存储**，这是边缘计算中最基础的数据持久化能力。

```typescript
interface KVStore {
  get(key: string): Promise<string | null>;
  getJSON<T>(key: string): Promise<T | null>;
  put(key: string, value: string, options?: KVPutOptions): Promise<void>;
  putJSON<T>(key: string, value: T, options?: KVPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<KVListResult>;
}

interface KVPutOptions {
  expirationTtl?: number;  // 过期时间（秒）
  metadata?: Record<string, any>;
}

interface KVListResult {
  keys: Array<{ name: string; metadata?: any }>;
  cursor?: string;
  list_complete: boolean;
}
```

**使用示例**:

```typescript
export default async function handler(context: Context) {
  const kv = context.services.kv;

  // 获取值
  const value = await kv.get('user:123');

  // 获取 JSON
  const user = await kv.getJSON<{ name: string }>('user:123');

  // 存储值（带过期时间）
  await kv.put('session:abc', 'data', {
    expirationTtl: 3600  // 1 小时后过期
  });

  // 存储 JSON
  await kv.putJSON('user:123', { name: 'Alice', age: 30 });

  // 删除
  await kv.delete('user:123');

  // 列出键
  const result = await kv.list('user:');

  return new Response(JSON.stringify(result));
}
```

**配置**:

KV Storage 是基础服务，**无需在配置中启用**，所有平台自动提供。

```typescript
// 直接使用，无需配置
export default async function handler(context: Context) {
  const kv = context.services.kv;  // 总是可用
  await kv.put('key', 'value');
  return new Response('OK');
}
```

可选：某些平台可能需要指定 namespace（命名空间）：

```json
{
  "services": {
    "kv": {
      "namespace": "MY_KV_STORE"  // 平台特定配置（可选）
    }
  }
}
```

**平台实现**:

| 平台 | 实现方式 | 值大小限制 |
|------|---------|-----------|
| Cloudflare | KV Namespaces | ≤ 25MB |
| Deno | Deno KV | ≤ 64KB |
| Tencent | EdgeKV | ≤ 2MB |
| Deislet | deis-store 的 KvStore（每租户一个 SQLite） | 无单值上限，实际卡在 gRPC 单条消息 16MB；键 ≤ 1KB |

---

## 7. Cache API (Basic)

**所有平台必须支持 Cache API**，用于 HTTP 响应缓存（非持久化存储）。

```typescript
interface Cache {
  put(request: Request | URL | string, response: Response): Promise<void>;
  match(request: Request | URL | string): Promise<Response | undefined>;
  delete(request: Request | URL | string): Promise<boolean>;
}
```

键的三种写法指向同一条记录：`URL` 与字符串按其完整 URL 取键，`Request` 按它的
`.url`。本节下面的示例用的正是 `new URL(context.request.url)`，所以 `URL` 必须在
签名里——早前的签名只写了 `Request | string`，与自己的示例对不上。

**使用示例**:

```typescript
export default async function handler(context: Context) {
  const cache = context.services.cache;
  const cacheKey = new URL(context.request.url);

  // 1. 尝试从缓存获取
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  // 2. 生成响应
  const response = new Response('Hello World', {
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'public, max-age=3600'
    }
  });

  // 3. 存入缓存
  await cache.put(cacheKey, response.clone());

  return response;
}
```

**缓存策略**:

**Cache-First 策略**:
```typescript
export default async function handler(context: Context) {
  const cache = context.services.cache;
  const url = new URL(context.request.url);

  // 检查缓存
  const cached = await cache.match(url);
  if (cached) return cached;

  // 请求源站并缓存
  const response = await fetch(url);
  if (response.ok) {
    await cache.put(url, response.clone());
  }

  return response;
}
```

**Stale-While-Revalidate 策略**:
```typescript
export default async function handler(context: Context) {
  const cache = context.services.cache;
  const url = new URL(context.request.url);

  const cached = await cache.match(url);

  // 后台更新缓存
  context.waitUntil(
    fetch(url).then(res => cache.put(url, res))
  );

  // 立即返回缓存（即使过期）
  return cached || fetch(url);
}
```

**配置**:

Cache API 是基础服务，**无需在配置中启用**，所有平台自动提供。

```typescript
// 直接使用，无需配置
export default async function handler(context: Context) {
  const cache = context.services.cache;  // 总是可用
  await cache.put(request, response);
  return new Response('OK');
}
```

**平台实现**:

所有平台均支持标准 Cache API，无需额外配置。

---

## 8. Web 标准 API (Basic)

### 8.1 必须支持的 Web APIs

所有平台必须支持以下标准 Web APIs：

**HTTP & Network**:
- `Request`, `Response`, `Headers`
- `fetch(url, options)` - 发起 HTTP 请求
- `URL`, `URLSearchParams` - URL 解析

**Cryptography**:
- `crypto.randomUUID()` - 生成 UUID
- `crypto.subtle.*` - Web Crypto API（加密、解密、签名）

**Encoding**:
- `TextEncoder`, `TextDecoder` - 文本编解码
- `btoa()`, `atob()` - Base64 编解码

**Streams**:
- `ReadableStream`, `WritableStream`, `TransformStream`

**Time**:
- `Date.now()`, `Date` 构造函数
- `setTimeout()`, `setInterval()` - 计时器

**JSON**:
- `JSON.parse()`, `JSON.stringify()`

**平台现状**: 这份清单是要求，不是各平台的现状。目前唯一有明确缺口的是 Deislet：
`fetch`、`crypto`、`ReadableStream` / `WritableStream` / `TransformStream`、
`setInterval` / `clearInterval` 这几项在它的 Isolate 里不存在，调用会直接
`ReferenceError`。逐项清单与实测方式见 `PLATFORM_MATRIX.md` 的 Deislet 一节。

### 8.2 示例

```typescript
export default async function handler(context: Context) {
  // 1. Fetch API
  const res = await fetch('https://api.example.com/data');
  const data = await res.json();

  // 2. Crypto
  const uuid = crypto.randomUUID();

  // 3. URL 解析
  const url = new URL(context.request.url);
  const searchParams = url.searchParams;

  // 4. Base64 编码
  const encoded = btoa('Hello World');

  return new Response(JSON.stringify({
    uuid,
    encoded,
    data
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

---

## 9. 错误处理 (Basic)

### 9.1 标准 JSON 错误格式

```typescript
interface ErrorResponse {
  error: {
    code: string;              // 机器可读错误代码 (大写下划线)
    message: string;           // 人类可读描述
    requestId?: string;        // 追踪 ID
    details?: any;             // 可选的结构化数据
  };
}
```

### 9.2 标准错误代码

| 代码 | HTTP 状态 | 说明 |
|------|----------|------|
| `INVALID_REQUEST` | 400 | 请求参数缺失或无效 |
| `UNAUTHORIZED` | 401 | 认证失败或缺失 |
| `FORBIDDEN` | 403 | 已认证但无权访问 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `RESOURCE_EXHAUSTED` | 429 | 超过速率限制或配额 |
| `INTERNAL_ERROR` | 500 | 未处理异常或内部错误 |
| `TIMEOUT` | 504 | 执行时间超过限制 |

### 9.3 未捕获异常

handler 抛出未捕获异常时：
1. 平台捕获异常
2. 返回 **500 Internal Server Error**
3. 记录堆栈到系统日志
4. **生产环境不会**将堆栈泄露给客户端

---

## 10. 性能与限制 (Basic)

### 10.1 一般限制

- **最大执行时间**: 30s (建议)
- **最大请求体**: 10MB (建议)
- **最大响应体**: 10MB (建议)

**注意**: 各平台实际限制可能不同。查看 [PLATFORM_MATRIX.md](./PLATFORM_MATRIX.md) 了解详情。

---

## 11. 示例

### 11.1 最小 Hello World

```typescript
// functions/index.ts
export default async function handler(context: Context) {
  return new Response("Hello World");
}
```

### 11.2 带环境变量和参数

```typescript
// functions/api/users/[id].ts
export default async function handler(context: Context) {
  const userId = context.params.id;
  const apiKey = context.env.API_KEY;

  context.log.info({
    message: "Processing user request",
    userId
  });

  // 调用外部 API
  const res = await fetch(`https://api.example.com/users/${userId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });

  if (!res.ok) {
    return new Response(JSON.stringify({
      error: {
        code: "NOT_FOUND",
        message: `User ${userId} not found`
      }
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const user = await res.json();
  return new Response(JSON.stringify(user), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

### 11.3 后台任务

```typescript
export default async function handler(context: Context) {
  // 主响应
  const response = new Response("Request received");

  // 后台任务（不阻塞响应）
  context.waitUntil(
    async function() {
      await fetch('https://analytics.example.com/track', {
        method: 'POST',
        body: JSON.stringify({ event: 'page_view' })
      });
    }()
  );

  return response;
}
```

---

## 12. 编译与部署

### 12.1 验证

```bash
deforge validate
```

检查代码是否符合基础规范（无平台特定代码）。

### 12.2 构建

```bash
deforge build
```

为所有启用的平台生成构建产物。

### 12.3 部署

```bash
# 方式 1: 使用平台原生工具
cd dist/cloudflare && wrangler deploy
cd dist/deno && deployctl deploy
cd dist/tencent && tccli deploy

# 方式 2: 使用统一 CLI (计划中)
denictl deploy --vendor cloudflare
```

---

## 13. 基础保证

遵循此基础规范的项目具有以下保证：

1. ✅ **通用性**: 代码可在任何 Edge Canon 兼容平台运行
2. ✅ **零平台泄露**: 无需修改即可切换平台
3. ✅ **类型安全**: 完整的 TypeScript 类型定义
4. ✅ **可预测性**: 行为在所有平台上一致
5. ✅ **持久化能力**: KV 存储和 Cache 作为基础服务保证可用

---

## 14. 扩展特性

基础规范之外的扩展特性（SQL Database、Object Storage、WebSocket 等）请参阅：
- [SPECIFICATION_EXT.md](./SPECIFICATION_EXT.md) - 扩展特性规范
- [PLATFORM_MATRIX.md](./PLATFORM_MATRIX.md) - 平台支持矩阵

---

**版本**: 0.1.0
**最后更新**: 2025-01-24

*此文档定义了 Edge Canon 的最小保证集。任何声称"Edge Canon 兼容"的平台必须实现这些接口。*
