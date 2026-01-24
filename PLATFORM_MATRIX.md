# Platform Support Matrix

> 精确定义各平台对 Edge Canon 特性的支持情况
> 编译器 (deforge) 在构建时会自动验证平台兼容性

---

## 特性分类

Edge Canon 将所有特性分为两类：

### Core Features (核心特性)

**必须全平台支持**的基础能力。任何声称支持 Edge Canon 的平台都必须实现这些特性。

### Extended Features (扩展特性)

**可选支持**的增强能力。平台可以选择性实现。编译器在构建时会检查目标平台是否支持项目使用的扩展特性，不支持则报错并提供替代方案。

---

## Core Features (✅ 全平台支持)

| 特性 | 说明 | 标准接口 |
|------|------|---------|
| **HTTP Handler** | 基础请求/响应处理 | `(context: Context) => Promise<Response>` |
| **Request/Response** | 标准 Fetch API | `Request`, `Response`, `Headers` |
| **Environment Variables** | 环境变量访问 | `context.env` |
| **Route Parameters** | 动态路由参数 | `context.params` |
| **Lifecycle Hooks** | 后台任务延迟 | `context.waitUntil()` |
| **Structured Logging** | 日志记录 | `context.log.info/warn/error()` |
| **Web Standards** | Fetch, URL, Crypto | `fetch()`, `URL`, `crypto` |

---

## Extended Features (⚠️ 部分支持)

### Storage & Persistence

| Feature | Cloudflare | Deno | Tencent | Deislet | 实现方式 |
|---------|-----------|------|---------|---------|---------|
| **KV Storage** | ✅ | ✅ | ✅ | ✅ | KV Namespaces / Deno KV / EdgeKV / Denix KV |
| **SQL Database** | ✅ | ✅ | ❌ | ✅ | D1 / Postgres / - / Remote gRPC |
| **Object Storage** | ✅ | ❌ | ❌ | ✅ | R2 / - / - / Remote gRPC |

**替代方案（无 SQL 数据库）**:
- 使用 KV 存储简单数据
- 连接外部数据库服务（Postgres、MySQL）
- 切换到支持数据库的平台

**替代方案（无对象存储）**:
- 使用外部 S3 兼容服务
- 切换到支持对象存储的平台

### Runtime & Execution

| Feature | Cloudflare | Deno | Tencent | Deislet | 说明 |
|---------|-----------|------|---------|---------|------|
| **Node.js Runtime** | ⚠️ | ✅ | ✅ | ✅ | Limited / Compat Layer / Node Functions / Native |
| **Server-Side Rendering** | ❌ | ✅ | ✅ | ✅ | - / Native SSR / Framework SSR / Native |
| **Incremental Static Regeneration** | ❌ | ✅ | ✅ | ⚠️ | - / ISR with revalidation / Framework ISR / Planned |
| **WebAssembly (Wasm)** | ✅ | ✅ | ✅ | ✅ | Native / Native / Native / Native |

**Cloudflare Node.js 限制**:
- 仅支持 `nodejs_compat` 兼容标志（有限功能）
- 不支持完整 Node.js 运行时
- 建议使用 Web 标准替代

### Scheduling & Messaging

| Feature | Cloudflare | Deno | Tencent | Deislet | 实现方式 |
|---------|-----------|------|---------|---------|---------|
| **Cron Jobs** | ✅ | ✅ | ❌ | ✅ | Cron Triggers / Deno.cron / - / Native |
| **Message Queues** | ✅ | ❌ | ❌ | ✅ | Queues / - / - / Native (Memory) |
| **Durable Objects** | ✅ | ❌ | ❌ | ⚠️ | Durable Objects / - / - / Planned |

**替代方案（无定时任务）**:
- 使用外部 cron 服务（GitHub Actions、云函数定时触发）
- 切换到支持 cron 的平台

**替代方案（无消息队列）**:
- 使用外部消息队列服务（Redis、RabbitMQ）
- 切换到支持队列的平台

### Real-time Communication

| Feature | Cloudflare | Deno | Tencent | Deislet | 说明 |
|---------|-----------|------|---------|---------|------|
| **WebSockets** | ✅ | ✅ | ❌ | ✅ | WebSocket API / WebSocket API / - / Native |
| **BroadcastChannel** | ❌ | ✅ | ❌ | ✅ | - / BroadcastChannel / - / Native |

**替代方案（无 WebSocket）**:
- 使用 Server-Sent Events (SSE) 进行单向推送
- 使用轮询（Polling）
- 切换到支持 WebSocket 的平台

### AI & Specialized Services

| Feature | Cloudflare | Deno | Tencent | Deislet | 说明 |
|---------|-----------|------|---------|---------|------|
| **Workers AI** | ✅ | ❌ | ❌ | ❌ | Workers AI / - / - / - |

**替代方案（无 AI 推理）**:
- 使用外部 AI API（OpenAI、Anthropic、Google AI）
- 切换到 Cloudflare Workers

---

## 完整特性映射（按平台）

### Cloudflare Workers

**✅ 支持**:
- KV Storage (KV Namespaces)
- SQL Database (D1)
- Object Storage (R2)
- Cron Jobs (Cron Triggers)
- WebSockets (WebSocket API)
- Durable Objects
- Message Queues (Queues)
- Workers AI
- WebAssembly

**⚠️ 有限支持**:
- Node.js Runtime (nodejs_compat flag, limited)

**❌ 不支持**:
- Server-Side Rendering
- Incremental Static Regeneration
- BroadcastChannel

### Deno Deploy

**✅ 支持**:
- KV Storage (Deno KV)
- SQL Database (Postgres via integration)
- Node.js Runtime (Compatibility layer)
- Server-Side Rendering (Native)
- Incremental Static Regeneration
- Cron Jobs (Deno.cron)
- WebSockets (WebSocket API)
- BroadcastChannel
- WebAssembly

**❌ 不支持**:
- Object Storage
- Durable Objects
- Message Queues
- Workers AI

### Tencent EdgeOne Pages

**✅ 支持**:
- KV Storage (EdgeKV)
- Node.js Runtime (Node Functions)
- Server-Side Rendering (Framework SSR)
- Incremental Static Regeneration (Framework ISR)
- WebAssembly

**❌ 不支持**:
- SQL Database
- Object Storage
- Cron Jobs
- WebSockets
- Durable Objects
- Message Queues
- BroadcastChannel
- Workers AI

### Deislet (Self-Hosted)

**✅ 支持**:
- KV Storage (Denix KV)
- SQL Database (Remote gRPC)
- Object Storage (Remote gRPC)
- Node.js Runtime (Native)
- Server-Side Rendering (Native)
- Cron Jobs (Native)
- WebSockets (Native)
- Message Queues (Native, Memory-based)
- BroadcastChannel (Native)
- WebAssembly

**⚠️ 计划中**:
- Incremental Static Regeneration
- Durable Objects

**❌ 不支持**:
- Workers AI

---

## 编译器验证机制

### 自动检测

`deforge` 编译器会自动检测项目使用的扩展特性：

```typescript
// .config.json
{
  "services": {
    "kv": { "enabled": true },      // ← 检测到使用 KV
    "database": { "enabled": true } // ← 检测到使用 Database
  }
}
```

### 构建时验证

当构建到不支持的平台时，编译器会报错：

```bash
$ deforge build --vendor tencent

✗ Platform capability validation failed
Project cannot be deployed to EdgeOne Pages due to unsupported features:

1. Feature 'SQL Database' is not supported on EdgeOne Pages
   Description: SQL database for relational data
   Platform: EdgeOne Pages does not provide this capability

   Alternatives:
     1. Use external database service (Postgres, MySQL)
     2. Use EdgeKV for simple key-value data
     3. Deploy to Cloudflare Workers (D1) or Deno Deploy (Postgres)

Error: Platform EdgeOne Pages does not support required features
```

### 多平台构建策略

如果项目需要部署到多个平台，建议：

1. **最小公约数**：只使用所有目标平台都支持的特性
2. **平台特定构建**：针对不同平台使用不同的特性集
3. **外部服务**：将平台特定功能抽象为外部服务

---

## 更新日志

- **2025-01-24**: 基于 deforge v0.1 平台能力验证系统创建
- 数据来源：`deforge-core/src/platform_capabilities.rs`

---

**注意**: 本矩阵与编译器实现保持同步。如发现不一致，以编译器验证结果为准。
