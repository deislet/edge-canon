# Edge Canon Specification v0.1.0

> **版本边界：** 本文描述已有 v0.1 契约，其中 Basic/Extended 的划分不会进入
> 下一标准版本。单一、无 profile 的契约及发布门槛见
> [Proposal 0001](proposals/0001-unified-platform-contract/README.zh.md)。

> 统一边缘函数部署标准规范
> 支持多平台兼容发布（Cloudflare Workers/Pages、Deno Deploy、Tencent EdgeOne、**Deislet**）
> **核心原则**：一次编写,随处部署;禁止平台特定代码
> [English](./SPECIFICATION.md)

## 📚 规范文档组织

本文档包含 **Basic (基础)** 和 **Extended (扩展)** 两类特性：

- **Basic**：所有平台必须支持的基础能力（第 1-10 章）
- **Extended**：平台可选支持的增强特性（第 11-16 章），编译时验证

详细分类参见：
- [SPECIFICATION_BASIC.md](./SPECIFICATION_BASIC.md) - 仅基础特性
- [SPECIFICATION_EXT.md](./SPECIFICATION_EXT.md) - 仅扩展特性

---

## 1. 项目结构规范 (Basic)

### 1.1 目录结构

```
my-edge-app/
├── functions/                    # 核心函数目录（必需）
│   ├── index.ts                  # 入口点（默认路由）
│   ├── hello.ts                  # 路由：/hello
│   ├── api/
│   │   ├── index.ts              # 路由：/api
│   │   ├── users.ts              # 路由：/api/users
│   │   ├── posts/
│   │   │   ├── index.ts          # 路由：/api/posts
│   │   │   └── [id].ts           # 路由：/api/posts/:id (动态参数)
│   │   └── [[catch]].ts          # 路由：/api/* (catch-all)
│   └── middleware.ts             # 全局中间件（可选）
├── .config.json                  # 通用配置文件（必需）
├── .env                          # 本地环境变量（开发用）
├── .env.production               # 生产环境变量（部署用）
├── package.json                  # 项目元数据（可选）
└── README.md                     # 项目说明文档
```

### 1.2 配置文件标准（.config.json）

参见 [schemas/config.schema.json](../schemas/config.schema.json) 获取正式定义。

```json
{
  "version": "0.1.0",
  "name": "my-edge-app",
  "description": "Edge Function Project",
  "runtime": "standard-v1",
  "entryPoint": "functions/index.ts",
  "services": {
    "kv": { "enabled": true, "binding": "KV_STORE" },
    "database": { "enabled": true, "binding": "DB" },
    "cache": { "enabled": true, "binding": "CACHE" }
  },
  "vendors": {
    "cloudflare": { "enabled": true },
    "deno": { "enabled": true },
    "tencent": { "enabled": true }
  }
}
```

### 1.3 配置字段参考表

| 字段 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `version` | string | **必需** | 规范版本 (如 "0.1.0") |
| `name` | string | **必需** | 项目名称 (kebab-case) |
| `runtime` | string | `"standard-v1"` | 目标运行时环境 |
| `language` | string | `"typescript"` | 源码语言 ("typescript" 或 "javascript") |
| `entryPoint` | string | **必需** | 主入口文件 (如 "functions/index.ts") |
| `functionRoot` | string | `"./functions"` | 文件系统路由的根目录 |
| `routing.caseSensitive` | boolean | `false` | 路由是否区分大小写 |
| `routing.dynamicParamPattern` | string | `"[param]"` | 动态参数段的匹配模式 |
| `routing.catchAllPattern` | string | `"[[catchall]]"` | 全捕获段的匹配模式 |
| `build.outDir` | string | `"./dist"` | 构建产物输出目录 |
| `build.minify` | boolean | `true` | 启用代码压缩 |
| `build.sourceMap` | boolean | `false` | 生成 Source Map |

---

## 2. 核心原则 (Basic)

### 2.1 强制要求

1. **禁止平台特定代码**
   - 不允许检测平台类型（如 `if (isCloudflare)`）
   - 不允许条件导入平台特定模块
   - 不允许访问平台原生 API（无 `raw` 或 `env` 的直接访问）
   
2. **代码完全通用**
   - 开发者只能使用规范定义的统一接口
   - 编译器负责将统一接口转换为平台实现
   
3. **编译时能力协商**
   - 如果某个平台不支持某个功能，编译时报错
   - 开发者在 `.config.json` 中声明需要的能力，编译器检查兼容性

### 2.2 违规示例（禁止）

```typescript
// ❌ 禁止：检测平台
if (typeof Deno !== 'undefined') { }

// ❌ 禁止：条件导入
const kv = import(isCloudflare ? '@cloudflare/kv' : '@deno/kv');

// ❌ 禁止：直接访问平台 API
const cfKV = env.MY_KV_NAMESPACE;
```

### 2.3 正确做法（推荐）

```typescript
// ✅ 只使用统一接口
export default async function handler(context: Context): Promise<Response> {
  const kv = context.services.kv;
  const value = await kv.get('mykey');
  return new Response(value || 'not found');
}
```

---

## 3. Handler 函数标准 (Basic)

### 3.1 通用 Handler 接口

所有函数必须导出一个标准的 HTTP Handler，支持以下两种形式：

#### 方式一：默认导出（推荐）

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

#### 方式二：具体方法导出（可选支持）

```typescript
export async function onRequest(context: Context): Promise<Response> {
  return new Response('Hello World');
}

export async function onRequestGet(context: Context): Promise<Response> {
  return new Response('GET response');
}
```

### 3.2 严格模式策略

为了避免歧义，推荐使用**严格模式**，即在一个文件中禁止混用多种导出形式。

如果同时检测到 `default export` 和 `onRequest`，编译器将以 **`default export` 优先**，并忽略其他具名导出。建议开发者明确选择一种风格。

### 3.3 Context 标准接口

```typescript
interface Context {
  request: Request;
  env: Record<string, string>;
  params: Record<string, string>;
  
  services: {
    kv?: KVStore;
    database?: Database;
    cache?: Cache;
    blob?: BlobStore;
    queue?: Queue;
  };

  log: Logger;
  waitUntil(promise: Promise<any>): void;
}
```

---

## 4. 基础 Handler 示例 (Basic)

### 示例 1：最小化 Hello World

```typescript
export default async function handler(context: Context) {
  return new Response("Hello World");
}
```

---

## 5. 路由规范 (Basic)

### 5.1 自动路由生成

函数目录结构自动映射为 HTTP 路由：

| 文件路径 | 生成的路由 | 说明 |
|-----------|-------|---|
| `functions/index.ts` | `/` | 根路由 |
| `functions/api/users.ts` | `/api/users` | 嵌套路由 |
| `functions/users/[id].ts` | `/users/:id` | 动态参数 |
| `functions/api/[[catch]].ts` | `/api/*` | 捕获所有 |

### 5.2 动态参数语法

- `[param]` → 单个动态参数
- `[[catchall]]` → 捕获所有剩余路径

---

## 6. 环境变量和密钥管理 (Basic)

### 6.1 定义方式

**必须**在 `.config.json` 中声明所有环境变量和密钥（显式声明原则）。未声明的变量在部署时将被忽略，且可能导致编译警告。

```json
{
  "environment": {
    "variables": { "LOG_LEVEL": "info" },
    "secrets": ["API_KEY"]
  }
}
```

### 6.2 本地开发与生产环境

- **本地开发**: 使用项目根目录下的 `.env` 文件填充值（不提交到版本库）。
- **生产环境**: 通过 CLI 或平台后台注入密钥。

### 6.3 访问方式

```typescript
const apiKey = context.env.API_KEY;
```

---

## 7. KV Store (Basic)

### 7.1 接口定义

```typescript
interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

---

## 8. Cache API (Basic)

### 8.1 接口定义

```typescript
interface Cache {
  put(request: Request | string, response: Response): Promise<undefined>;
  match(request: Request | string): Promise<Response | undefined>;
  delete(request: Request | string): Promise<boolean>;
}
```

---

## 9. 错误处理标准 (Basic)

### 9.1 标准 JSON 错误格式

所有 API **应该**返回一致的 JSON 格式错误,以便客户端进行程序化处理。

```typescript
interface ErrorResponse {
  error: {
    code: string;              // 机器可读错误码 (大写下划线)
    message: string;           // 人类可读描述
    requestId?: string;        // 用于调试的追踪 ID
    details?: any;             // 可选的结构化详情数据
  };
}
```

### 9.2 标准错误码

平台保留并推荐应用使用的通用错误码：

| 错误码 | HTTP 状态 | 说明 |
| :--- | :--- | :--- |
| `INVALID_REQUEST` | 400 | 请求参数缺失或无效 |
| `UNAUTHORIZED` | 401 | 认证失败或未提供凭证 |
| `FORBIDDEN` | 403 | 已认证但无权限访问资源 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `RESOURCE_EXHAUSTED` | 429 | 超过速率限制或配额耗尽 |
| `INTERNAL_ERROR` | 500 | 未捕获异常或平台内部错误 |
| `TIMEOUT` | 504 | 执行时间超过限制 |

### 9.3 未捕获异常

当 Handler 抛出未捕获异常时：
1. 平台会捕获该异常。
2. 返回 **500 Internal Server Error**。
3. 将堆栈跟踪记录到系统日志（可通过 `denictl logs` 查看）。
4. 用户端仅收到通用错误信息（生产环境**绝不**泄露堆栈信息）。

---

## 10. 性能与限制 (Basic)

### 10.1 通用限制

- **最大执行时间 (CPU Time)**: **30s** (硬限制,超时强制终止)
- **内存限制 (Memory)**: **128MB** (默认),超限将触发 OOM 终止而非崩溃。
- **速率限制 (Rate Limit)**: 默认为 **1000 ops/sec** (IOPS),防止资源滥用。
- **最大请求 / 响应**: 50MB

### 10.2 结构化日志与指标 (Metrics)

Edge Canon 采用 **"Log-based Metrics"** (基于日志的指标) 策略。开发者通过 `context.log` 输出结构化 JSON 日志,平台会自动从中提取监控指标。无需引入额外的监控 SDK。

#### 接口定义

```typescript
interface Logger {
  debug(msg: string | LogEvent): void;
  info(msg: string | LogEvent): void;
  warn(msg: string | LogEvent): void;
  error(msg: string | LogEvent): void;
}

interface LogEvent {
  message: string;             // 人类可读的日志消息
  [key: string]: any;          // 任意业务上下文 (如 user_id)

  // 可选：嵌入式指标定义
  metric?: {
    name: string;              // 指标名称 (如 'payment_success')
    value: number;             // 指标值
    type: 'counter' | 'gauge' | 'histogram'; // 指标类型
    unit?: string;             // 单位 (ms, bytes, count)
    tags?: Record<string, string>; // 维度标签
  };
}
```

#### 使用示例

**1. 计数器 (Counter)**

记录发生的次数（如：下单成功）。

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

**2. 直方图 (Histogram)**

记录分布情况（如：处理耗时）。

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

## 11. Database 存储 (Extended)

> **扩展特性**：平台可选支持,编译时验证

### 11.1 接口定义

```typescript
interface Database {
  query<T>(sql: string, params?: any[]): Promise<T[]>;
  execute(sql: string, params?: any[]): Promise<ExecuteResult>;
  transaction<T>(callback: (tx: Database) => Promise<T>): Promise<T>;
}
```

---

## 12. Blob Store (Extended)

> **扩展特性**：平台可选支持,编译时验证

### 12.1 接口定义

```typescript
interface BlobStore {
  get(key: string): Promise<BlobObject | null>;
  put(key: string, data: ReadableStream | string): Promise<BlobObject>;
  delete(key: string): Promise<void>;
}
```

---

## 13. Queue 消息队列 (Extended)

> **扩展特性**：平台可选支持,编译时验证

### 13.1 接口定义

```typescript
interface Queue {
  send(message: any): Promise<void>;
}
```

---

## 14. 调试协议 Inspector (Extended)

> **扩展特性**：平台可选支持,编译时验证

### 14.1 远程调试协议 (Inspector Protocol)

Deislet 平台支持基于 WebSocket 的远程调试（兼容 Chrome DevTools Protocol）。

- **连接方式**: `ws://<host>:<port>/`
- **必需 Headers**:
  - `x-deis-app-id`: `_inspect:<app_id>` (调试路由标识)
  - `x-denix-inspect-token`: `<token>` (由 `StartInspect` 接口返回的临时令牌)
  - `Upgrade`: `websocket`

> **注意**: 调试会话具有时间限制（默认 300秒），超时后会自动断开。

### 14.2 路由标识规范

在生产环境部署中，路由标识分为两个层面：

1.  **用户层面 (Public)**: 用户通过域名访问（如 `app.example.com`），**无需**感知内部 ID。
2.  **系统层面 (Internal)**: 负载均衡器 (LB) 负责将域名映射为 `x-deis-app-id`。
    - **安全清洗**: LB 必须清除用户请求中可能携带的 `x-deis-app-id`，防止越权。
    - **可信传递**: 仅 LB 到 Runtime 之间的链路信任此 Header。

---

## 15. WebSocket 支持 (Extended)

> **扩展特性**：平台可选支持,编译时验证

Edge Canon 为 WebSocket 客户端和服务端（Upgrade 请求处理）提供标准支持。

### 15.1 WebSocket 客户端

使用标准的 `WebSocket` API 连接外部服务。

```typescript
const socket = new WebSocket("wss://echo.websocket.org");
socket.onmessage = (event) => console.log(event.data);
socket.send("Hello");
```

### 15.2 WebSocket 服务端 (Upgrade)

要接受 WebSocket 连接，需返回 `101 Switching Protocols` 状态码和 `webSocket` 选项。我们推荐使用 `WebSocketPair` 模式以获得更好的平台兼容性（类似于 Cloudflare 风格）。

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

## 16. WebAssembly 支持 (Extended)

> **扩展特性**：平台可选支持,编译时验证

Edge Canon 将 WebAssembly 视为高性能计算的一等公民。

### 16.1 导入与实例化

`.wasm` 文件作为 ES 模块导入。导入对象是一个 `WebAssembly.Module`（而非实例），允许开发者控制实例化过程。

```typescript
// functions/utils/math.wasm
import mathModule from './math.wasm';

export default async function handler(context: Context) {
  // 1. 定义导入对象 (如果 Wasm 模块需要)
  const importObject = {
    env: {
      log: (arg) => console.log(arg)
    }
  };

  // 2. 实例化
  const instance = await WebAssembly.instantiate(mathModule, importObject);
  
  // 3. 调用导出函数
  const result = instance.exports.add(10, 20);
  return new Response(`Result: ${result}`);
}
```

### 16.2 限制与指南

*   **体积限制**: Wasm 二进制文件建议控制在 **1MB** 以内，以确保冷启动速度。
*   **WASI 支持**: 目前为 **实验性支持**。建议使用 `wasm32-unknown-unknown` 编译目标（纯计算，无系统调用）。
*   **内存使用**: Wasm 内存计入 Isolate 总内存限制（通常为 128MB）。
*   **同步执行**: Wasm 函数在主线程同步执行，会阻塞事件循环。避免运行耗时过长的循环。

---

## 17. 本地开发与测试

```bash
denictl dev
denictl test
```

---

## 18. 构建和发布

```bash
denictl build
denictl validate
denictl deploy
```

---

## 19. CLI 工具命令参考

参见 `denictl --help`。

---

## 20. 版本控制和兼容性

- **规范版本**: 0.1.0
- **发布日期**: TBD

---

## 21. 附录：规范的核心保证

1. **代码完全通用**
2. **一次编写、随处部署**
3. **零平台泄漏**
4. **高度可维护**

---

*本文档是“法典”。任何声称“符合 Edge Canon”的实现都必须遵守这些接口。*
