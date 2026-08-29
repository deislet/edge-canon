# Edge Canon Extended Specification v0.1.0

> **扩展规范**: 可选的增强特性
> **编译时验证**: 编译器会检查目标平台是否支持使用的扩展特性

---

## 1. 扩展特性概述

扩展特性是**可选的增强能力**，平台可以选择性实现。与核心规范不同：

- ✅ **核心规范**: 所有平台必须支持
- ⚠️ **扩展规范**: 平台可选支持，编译时检查

### 1.1 编译时验证机制

当项目使用扩展特性时，`deforge` 编译器会在构建时验证目标平台是否支持：

```bash
$ deforge build --vendor tencent

✗ Platform capability validation failed
Feature 'SQL Database' is not supported on EdgeOne Pages

Alternatives:
  1. Use external database service (Postgres, MySQL)
  2. Use EdgeKV for simple key-value data
  3. Deploy to Cloudflare Workers (D1) or Deno Deploy (Postgres)
```

### 1.2 平台支持矩阵

详细的平台支持情况请参阅 [PLATFORM_MATRIX.md](./PLATFORM_MATRIX.md)

---

## 2. 存储与持久化 (Storage & Persistence)

> **注意**: KV Storage 和 Cache API 已移至[基础规范](./SPECIFICATION_BASIC.md)，所有平台必须支持。

### 2.1 SQL Database

**支持平台**: ✅ Cloudflare, ✅ Deno, ❌ Tencent, ✅ Deislet

#### 接口定义

```typescript
interface Database {
  query<T>(sql: string, params?: any[]): Promise<T[]>;
  execute(sql: string, params?: any[]): Promise<ExecuteResult>;
  transaction<T>(callback: (tx: Database) => Promise<T>): Promise<T>;
}

interface ExecuteResult {
  rowsAffected: number;
  lastInsertId?: number;
}
```

#### 配置

```json
{
  "services": {
    "database": {
      "enabled": true,
      "binding": "DB",
      "connectionString": "postgres://..."  // 可选
    }
  }
}
```

#### 使用示例

```typescript
export default async function handler(context: Context) {
  const db = context.services.database;

  // 查询
  const users = await db.query<User>(
    'SELECT * FROM users WHERE age > ?',
    [18]
  );

  // 插入
  const result = await db.execute(
    'INSERT INTO users (name, email) VALUES (?, ?)',
    ['Alice', 'alice@example.com']
  );

  // 事务
  await db.transaction(async (tx) => {
    await tx.execute('INSERT INTO accounts (user_id, balance) VALUES (?, ?)', [1, 100]);
    await tx.execute('UPDATE users SET verified = 1 WHERE id = ?', [1]);
  });

  return new Response(JSON.stringify(users));
}
```

#### 平台实现

| 平台 | 实现方式 | 数据库类型 |
|------|---------|-----------|
| Cloudflare | D1 Database | SQLite |
| Deno | Postgres integration | PostgreSQL |
| Tencent | ❌ 不支持 | - |
| Deislet | deis-store，每租户一个独立 SQLite 文件，走 gRPC | SQLite |

**Deislet 说明（2026-08-29 回源码核对）**:
- `query` / `execute` 可用，参数与结果都以 JSON 过 Isolate 边界。
- `transaction` **不可用**：deis-store 每次调用落在连接池里任意一条连接上，没有能跨
  `await` 持住 `BEGIN` 的会话。调用它会抛错。此前它接下回调、不执行、直接 resolve，
  等于两条写入一条都没发生而调用方毫不知情；现在至少当场报错。
  替代：把语句拆成各自安全的 `execute`。

**Tencent 替代方案**:
- 使用外部数据库服务
- 使用 EdgeKV 存储简单数据
- 部署到其他支持数据库的平台

---

### 2.2 Object Storage (Blob)

**支持平台**: ✅ Cloudflare, ❌ Deno, ❌ Tencent, ✅ Deislet

#### 接口定义

```typescript
interface BlobStore {
  get(key: string): Promise<BlobObject | null>;
  put(key: string, data: ReadableStream | string | ArrayBuffer): Promise<BlobObject>;
  delete(key: string): Promise<void>;
  list(options?: BlobListOptions): Promise<BlobListResult>;
}

interface BlobObject {
  key: string;
  size: number;
  uploaded: Date;
  body: ReadableStream;
}

interface BlobListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}
```

#### 配置

```json
{
  "services": {
    "blob": {
      "enabled": true,
      "binding": "MY_BUCKET"
    }
  }
}
```

#### 使用示例

```typescript
export default async function handler(context: Context) {
  const blob = context.services.blob;

  // 上传文件
  const file = await blob.put('images/avatar.png', context.request.body);

  // 下载文件
  const obj = await blob.get('images/avatar.png');
  if (obj) {
    return new Response(obj.body, {
      headers: { 'Content-Type': 'image/png' }
    });
  }

  // 删除文件
  await blob.delete('images/avatar.png');

  return new Response('Not found', { status: 404 });
}
```

#### 平台实现

| 平台 | 实现方式 | 限制 |
|------|---------|------|
| Cloudflare | R2 Buckets | 对象大小无限制 |
| Deno | ❌ 不支持 | - |
| Tencent | ❌ 不支持 | - |
| Deislet | deis-store 内容寻址落盘，分块流式 Put/Get；`context.services.blob` 收字符串 / `ArrayBuffer` / `ArrayBufferView` | 服务端默认单对象 ≤ 512MB |

**Deislet 说明（2026-08-29）**:

`put` 接受字符串、`ArrayBuffer` 和任意 `ArrayBufferView`；`get` 回一个带
`arrayBuffer()` / `text()` / `json()` 的对象，键不存在时回 `null`；`delete` 幂等。
上面接口定义里的 `list()` 与「`put` 返回 `BlobObject`」这两项在 Deislet 上没有：
`put` 回 `undefined`，也没有列举接口。

这一格在 2026-08-29 之前是 ⚠️，因为 Isolate 侧两条路都断——`blob.put(key, "字符串")`
报 `TextEncoder is not defined`（运行时当时没装这个全局），`blob.put(key, arrayBuffer)`
报 `serde_v8 error: invalid type; expected: array, got: Uint8Array`（`op_blob_put`
的入参声明成了 `#[serde] Vec<u8>`，serde_v8 不收定型数组）。两处都已修好，
并且补了一条顶着真 deis-store 的 Isolate 端到端测试，字符串与原始字节双向往返；
在此之前仓库里没有任何测试从 Isolate 调过 blob，所以这个洞躺了很久没被照出来。

---

## 3. 调度与消息 (Scheduling & Messaging)

### 3.1 Cron Jobs (定时任务)

**支持平台**: ✅ Cloudflare, ✅ Deno, ❌ Tencent, ✅ Deislet

#### Handler 定义

```typescript
export async function scheduled(
  event: ScheduledEvent,
  env: Record<string, string>,
  context: Context
): Promise<void> {
  context.log.info({
    message: "Cron job triggered",
    scheduledTime: event.scheduledTime,
    cron: event.cron
  });

  // 执行定时任务逻辑
  await cleanupExpiredSessions();
}

interface ScheduledEvent {
  scheduledTime: number;  // Unix 时间戳 (ms)
  cron: string;           // Cron 表达式
}
```

#### 配置

```json
{
  "triggers": {
    "cron": [
      {
        "name": "cleanup",
        "schedule": "0 0 * * *",  // 每天午夜
        "handler": "functions/tasks/cleanup.ts"
      }
    ]
  }
}
```

#### 平台实现

| 平台 | 实现方式 | Cron 语法 |
|------|---------|----------|
| Cloudflare | Cron Triggers | 标准 Cron |
| Deno | Deno.cron | 标准 Cron |
| Tencent | ❌ 不支持 | - |
| Deislet | deis-control 按 (应用, 环境) 调度，到点只在一个健康节点上触发 | 标准 Cron |

**Deislet 说明**: 一次触发是「打出去就不管」——失败不重试，错过的那一次也不会补。
非做不可的活儿应该由这个 handler 往队列里塞，队列才有重试和死信。

**Tencent 替代方案**:
- 使用外部 cron 服务（GitHub Actions、云函数定时触发）
- 部署到支持 cron 的平台

---

### 3.2 Message Queues (消息队列)

**支持平台**: ✅ Cloudflare, ❌ Deno, ❌ Tencent, ✅ Deislet

#### 发送消息

```typescript
interface Queue {
  send(message: any): Promise<void>;
  sendBatch(messages: any[]): Promise<void>;
}

// 发送端
export default async function handler(context: Context) {
  const queue = context.services.queue;

  await queue.send({
    userId: 123,
    action: 'send_email',
    data: { to: 'user@example.com' }
  });

  return new Response('Message queued');
}
```

#### 消费消息

```typescript
export async function queue(
  batch: MessageBatch,
  env: Record<string, string>,
  context: Context
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processMessage(msg.body);
      msg.ack();  // 确认处理成功
    } catch (err) {
      msg.retry();  // 重试
    }
  }
}

interface MessageBatch {
  queue: string;
  messages: Message[];
}

interface Message {
  id: string;
  body: any;
  timestamp: number;
  ack(): void;
  retry(): void;
}
```

#### 平台实现

| 平台 | 实现方式 | 消息大小限制 |
|------|---------|-------------|
| Cloudflare | Queues | ≤ 128KB |
| Deno | ❌ 不支持 | - |
| Tencent | ❌ 不支持 | - |
| Deislet | deis-queue：SQLite 持久化，租约式 Pull + Ack / Nack，超次数进死信表 | 默认 ≤ 1MB（可配，硬顶 8MB）|

**Deislet 说明（2026-08-29 回源码核对）**:
- 不是内存队列。消息落在 SQLite 里，进程重启不丢；投递超过 `max_attempts`（默认 5 次）
  的消息进 `dead_letter` 表，默认永久保留，等人来看。
- 单条消息体默认上限 1MB（`max_body_bytes`），不是 10MB。可以调，但会被压到一次 Pull
  应答装得下的大小（`MAX_GRPC_MESSAGE_BYTES / 2`，即 8MB）——否则消息能存进去、永远发
  不出来。大东西应该放对象存储，队列里只传键。
- `message.body` 是**发送时的原文**，不是解析过的对象；`message.json()` 才是解析。
- `message.ack()` / `message.retry()` 都在。默认是「没说话就算办完了」：handler 正常返回
  后，没被 `retry()` 标记的消息全部确认；handler 抛异常则整批退回。

---

## 4. 实时通信 (Real-time Communication)

### 4.1 WebSockets

**支持平台**: ✅ Cloudflare, ✅ Deno, ❌ Tencent, ⚠️ Deislet

#### Server (Upgrade)

```typescript
export default async function handler(context: Context) {
  if (context.request.headers.get("Upgrade") === "websocket") {
    const { 0: client, 1: server } = new WebSocketPair();

    server.accept();
    server.addEventListener("message", (event) => {
      server.send(`Echo: ${event.data}`);
    });

    server.addEventListener("close", () => {
      console.log("WebSocket closed");
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  return new Response("Expected WebSocket", { status: 426 });
}
```

#### Client

```typescript
const socket = new WebSocket("wss://api.example.com/ws");
socket.onmessage = (event) => console.log(event.data);
socket.send("Hello");
```

#### 平台实现

| 平台 | 实现方式 | 连接限制 |
|------|---------|---------|
| Cloudflare | WebSocket API | 无明确限制 |
| Deno | WebSocket API | 无明确限制 |
| Tencent | ❌ 不支持 | - |
| Deislet | ⚠️ 只有节点内那一半：`WebSocketPair` 桥接 + 节点 HTTP 处理器接升级请求 | 未验证 |

**Deislet 保留**:
- 上面 **Server (Upgrade)** 那段写法在节点内部是通的，有进程内测试。
- 但覆盖 HTTP 升级那一段的集成测试在没有服务监听时会直接返回并算通过，等于没测；
  经过 deis-proxy 的那一跳从未端到端验证过。
- 上面 **Client** 那段在 Deislet 上**跑不了**：运行时没有把客户端 `WebSocket` 装到
  `globalThis` 上，`new WebSocket(...)` 是 `ReferenceError`。
- 二进制帧当前会被当成文本交付：解码那条路径用了 `atob`，而这个全局同样不存在，
  异常被 `catch` 吞掉，`event.data` 留下的是原始 JSON 字符串。

补上真正的测试之前不要按「可用」规划。

**Tencent 替代方案**:
- 使用 Server-Sent Events (SSE) 单向推送
- 使用轮询 (Polling)
- 部署到支持 WebSocket 的平台

---

### 4.2 BroadcastChannel

**支持平台**: ❌ Cloudflare, ✅ Deno, ❌ Tencent, ❌ Deislet

#### 接口定义

```typescript
const channel = new BroadcastChannel('notifications');

// 发送消息
channel.postMessage({ type: 'alert', message: 'Hello' });

// 接收消息
channel.onmessage = (event) => {
  console.log('Received:', event.data);
};
```

#### 使用场景

- 跨 isolate 实例通信
- 分布式缓存失效通知
- 实时协作功能

**Deislet 不支持**: 运行时没有把这个全局装到 `globalThis` 上（探针应用里
`typeof globalThis.BroadcastChannel === "undefined"`），Isolate 之间也没有共享总线。
`new BroadcastChannel(...)` 是 `ReferenceError`。

---

## 5. 运行时与执行 (Runtime & Execution)

### 5.1 Node.js Runtime

**支持平台**: ⚠️ Cloudflare (Limited), ✅ Deno, ✅ Tencent, ❌ Deislet

#### Cloudflare 限制

Cloudflare 仅提供有限的 Node.js 兼容性（`nodejs_compat` flag）：

**支持**:
- `buffer`, `events`, `stream`, `util`

**不支持**:
- `fs`, `net`, `child_process`, `cluster`

**建议**: 优先使用 Web 标准 API 或构建时 polyfill

#### Deno / Tencent

完整 Node.js 兼容层或原生支持。

#### Deislet 不支持

运行时是裸 `deno_core`，没有注册 `deno_node`：`require`、`Buffer`、`node:` 前缀模块
都不存在，也不做 npm 包解析。这不是排期问题，是形态上就没有。

---

### 5.2 Server-Side Rendering (SSR)

**支持平台**: ❌ Cloudflare, ✅ Deno, ✅ Tencent, ❌ Deislet

#### 使用示例

```typescript
import { renderToString } from 'react-dom/server';
import App from './App';

export default async function handler(context: Context) {
  const html = renderToString(<App />);

  return new Response(`<!DOCTYPE html><html>${html}</html>`, {
    headers: { 'Content-Type': 'text/html' }
  });
}
```

#### 平台实现

| 平台 | 支持方式 |
|------|---------|
| Cloudflare | ❌ 不支持（使用静态生成替代） |
| Deno | ✅ 原生 SSR 支持 |
| Tencent | ✅ Framework SSR (Next.js, Nuxt) |
| Deislet | ❌ 不支持 |

**Deislet 不支持**: 没有框架挂钩，也没有 npm 生态可依赖——上面这段示例的
`import ... from 'react-dom/server'` 在 Deislet 上解析不了。增量静态再生 (ISR) 同理。

---

### 5.3 WebAssembly (Wasm)

**支持平台**: ✅ Cloudflare, ✅ Deno, ✅ Tencent, ✅ Deislet

#### 导入与实例化

```typescript
import mathModule from './math.wasm';

export default async function handler(context: Context) {
  const instance = await WebAssembly.instantiate(mathModule, {});
  const result = instance.exports.add(10, 20);

  return new Response(`Result: ${result}`);
}
```

#### 约束与指南

- **大小限制**: 建议 ≤ 1MB（确保冷启动快）
- **WASI 支持**: 实验性，建议使用 `wasm32-unknown-unknown`
- **内存**: Wasm 内存计入 isolate 总内存限制
- **同步执行**: Wasm 函数同步执行，避免长时间循环

**Deislet 说明（2026-08-29 实测）**: `WebAssembly` 这个全局是 V8 自带的，在 Isolate 里
确实存在——探针应用里 `new WebAssembly.Module(bytes)` 加 `new WebAssembly.Instance(m)`
都跑通了，`WebAssembly.instantiateStreaming` 也在（但它要一个带流式主体的 `Response`，
而运行时的 `Response` 没有流式主体，所以这条路走不通）。上面示例里
`import mathModule from './math.wasm'` 这种写法：运行时的模块加载器认得 `.wasm` 说明符，
但 `deis build` 把 `.wasm` 打进函数代码这条链路没有端到端验证过，不要照抄。

---

## 6. AI 与专用服务

### 6.1 Workers AI

**支持平台**: ✅ Cloudflare, ❌ Deno, ❌ Tencent, ❌ Deislet

#### 接口定义

```typescript
interface AI {
  run(model: string, input: any): Promise<any>;
}
```

#### 使用示例

```typescript
export default async function handler(context: Context) {
  const ai = context.services.ai;

  const result = await ai.run('@cf/meta/llama-2-7b-chat-int8', {
    prompt: 'Hello, how are you?'
  });

  return new Response(JSON.stringify(result));
}
```

#### 平台实现

| 平台 | 实现方式 |
|------|---------|
| Cloudflare | Workers AI (原生) |
| Deno | ❌ 不支持 |
| Tencent | ❌ 不支持 |
| Deislet | ❌ 不支持 |

**替代方案**: 使用外部 AI API（OpenAI、Anthropic、Google AI）

---

## 7. 配置扩展特性

### 7.1 完整配置示例

```json
{
  "version": "0.1.0",
  "name": "my-edge-app",
  "runtime": "standard-v1",
  "language": "typescript",
  "functionRoot": "./functions",

  "services": {
    "database": {
      "enabled": true,
      "binding": "DB"
    },
    "blob": {
      "enabled": true,
      "binding": "MY_BUCKET"
    },
    "queue": {
      "enabled": true,
      "binding": "MY_QUEUE"
    }
  },

  "triggers": {
    "cron": [
      {
        "name": "cleanup",
        "schedule": "0 0 * * *",
        "handler": "functions/tasks/cleanup.ts"
      }
    ]
  },

  "vendors": {
    "cloudflare": { "enabled": true },
    "deno": { "enabled": true },
    "tencent": { "enabled": false }
  }
}
```

### 7.2 编译时检查

当构建时，编译器会验证目标平台是否支持启用的服务：

```bash
$ deforge build --vendor tencent

✗ Error: Platform 'tencent' does not support:
  - services.database (SQL Database)
  - services.blob (Object Storage)
  - triggers.cron (Cron Jobs)

Suggestions:
  1. Disable unsupported services in .config.json
  2. Use alternative platforms (cloudflare, deno)
  3. Use external services for missing features
```

---

## 8. 最佳实践

### 8.1 特性检测策略

**推荐**: 在配置中明确声明使用的特性

```json
{
  "services": {
    "kv": { "enabled": true },
    "database": { "enabled": false }  // 明确不使用
  }
}
```

### 8.2 多平台部署

**策略 1**: 使用最小公约数（所有平台都支持的特性）

**策略 2**: 平台特定构建

```json
{
  "vendors": {
    "cloudflare": {
      "enabled": true,
      "services": {
        "database": { "enabled": true },
        "blob": { "enabled": true }
      }
    },
    "tencent": {
      "enabled": true,
      "services": {
        "kv": { "enabled": true }
      }
    }
  }
}
```

**策略 3**: 外部服务抽象

将平台特定功能抽象为外部 HTTP API。

---

## 9. 参考

- [核心规范](./SPECIFICATION_CORE.md) - 所有平台必须支持的基础特性
- [平台支持矩阵](./PLATFORM_MATRIX.md) - 详细的平台兼容性表
- [兼容性策略](./COMPATIBILITY.md) - Node.js 生态兼容策略

---

**版本**: 0.1.0
**最后更新**: 2025-01-24

*扩展特性是可选的。编译器会确保项目不会部署到不兼容的平台。*
