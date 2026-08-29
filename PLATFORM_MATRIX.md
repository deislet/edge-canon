# Platform Support Matrix

> 精确定义各平台对 Edge Canon 特性的支持情况
> 编译器 (`deis-build`) 在构建时会自动验证平台兼容性

---

## 特性分类

Edge Canon 将所有特性分为两类：

### Basic Features (基础特性)

**必须全平台支持**的基础能力。任何声称支持 Edge Canon 的平台都必须实现这些特性。

### Extended Features (扩展特性)

**可选支持**的增强能力。平台可以选择性实现。编译器在构建时会检查目标平台是否支持项目使用的扩展特性，不支持则报错并提供替代方案。

---

## Basic Features (✅ 全平台支持)

| 特性 | 说明 | 标准接口 |
|------|------|---------|
| **HTTP Handler** | 基础请求/响应处理 | `(context: Context) => Promise<Response>` |
| **Request/Response** | 标准 Fetch API | `Request`, `Response`, `Headers` |
| **Environment Variables** | 环境变量访问 | `context.env` |
| **Route Parameters** | 动态路由参数 | `context.params` |
| **KV Storage** | 键值存储 | `context.services.kv` |
| **Cache API** | HTTP 响应缓存 | `context.services.cache` |
| **Lifecycle Hooks** | 后台任务延迟 | `context.waitUntil()` |
| **Structured Logging** | 日志记录 | `context.log.info/warn/error()` |
| **Web Standards** | Fetch, URL, Crypto | `fetch()`, `URL`, `crypto` |

---

## Extended Features (⚠️ 部分支持)

### Storage & Persistence

| Feature | Cloudflare | Deno | Tencent | Deislet | 实现方式 |
|---------|-----------|------|---------|---------|---------|
| **SQL Database** | ✅ | ✅ | ❌ | ✅ | D1 / Postgres / - / Per-tenant SQLite in deis-store（`query` / `execute` 可用，`transaction` 不可用，见下） |
| **Object Storage** | ✅ | ❌ | ❌ | ✅ | R2 / - / - / deis-store（内容寻址、分块流式 Put/Get）+ Isolate 里的 `context.services.blob`，字符串与 `Uint8Array` 双向实测 |

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
| **Node.js Runtime** | ⚠️ | ✅ | ✅ | ❌ | Limited / Compat Layer / Node Functions / - |
| **Server-Side Rendering** | ❌ | ✅ | ✅ | ❌ | - / Native SSR / Framework SSR / - |
| **Incremental Static Regeneration** | ❌ | ✅ | ✅ | ❌ | - / ISR with revalidation / Framework ISR / - |
| **WebAssembly (Wasm)** | ✅ | ✅ | ✅ | ✅ | Native / Native / Native / V8 自带的 `WebAssembly`，2026-08-29 在真实 Isolate 里 Module + Instance 实测通过 |

**Cloudflare Node.js 限制**:
- 仅支持 `nodejs_compat` 兼容标志（有限功能）
- 不支持完整 Node.js 运行时
- 建议使用 Web 标准替代

### Scheduling & Messaging

| Feature | Cloudflare | Deno | Tencent | Deislet | 实现方式 |
|---------|-----------|------|---------|---------|---------|
| **Cron Jobs** | ✅ | ✅ | ❌ | ✅ | Cron Triggers / Deno.cron / - / Scheduled by deis-control, run on one node |
| **Message Queues** | ✅ | ❌ | ❌ | ✅ | Queues / - / - / deis-queue：SQLite 持久化，租约式 Pull，超次数进死信；单条消息体默认 ≤ 1MB |
| **Durable Objects** | ✅ | ❌ | ❌ | ❌ | Durable Objects / - / - / - |

**替代方案（无定时任务）**:
- 使用外部 cron 服务（GitHub Actions、云函数定时触发）
- 切换到支持 cron 的平台

**替代方案（无消息队列）**:
- 使用外部消息队列服务（Redis、RabbitMQ）
- 切换到支持队列的平台

### Real-time Communication

| Feature | Cloudflare | Deno | Tencent | Deislet | 说明 |
|---------|-----------|------|---------|---------|------|
| **WebSockets** | ✅ | ✅ | ❌ | ⚠️ | WebSocket API / WebSocket API / - / 只有服务端那一半（`WebSocketPair` 桥接）；HTTP 升级与经 deis-proxy 的一跳未验证，客户端 `WebSocket` 全局不存在 |
| **BroadcastChannel** | ❌ | ✅ | ❌ | ❌ | - / BroadcastChannel / - / - |

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

**✅ 基础特性**: 全部支持
- HTTP Handler, Request/Response, 环境变量, 路由参数
- KV Storage (KV Namespaces)
- Cache API
- 生命周期, 日志, Web 标准

**✅ 扩展特性**:
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

**✅ 基础特性**: 全部支持
- HTTP Handler, Request/Response, 环境变量, 路由参数
- KV Storage (Deno KV)
- Cache API
- 生命周期, 日志, Web 标准

**✅ 扩展特性**:
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

**✅ 基础特性**: 全部支持
- HTTP Handler, Request/Response, 环境变量, 路由参数
- KV Storage (EdgeKV)
- Cache API
- 生命周期, 日志, Web 标准

**✅ 扩展特性**:
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

> Deislet is under active development. Every entry below was checked against
> the implementation on 2026-08-29, not against a changelog: by reading the
> code, and where a claim could be settled by running it, by a probe
> application executed inside a real isolate. Where the demo
> (`scripts/demo.sh verify`) exercises a capability end to end, it is named.
> A cell that says ⚠️ is a cell nobody should plan against yet, and the
> paragraph under it says exactly which half is missing.

**✅ 基础特性**:
- HTTP Handler
- 环境变量 — 控制面下发的环境表注入 `context.env`
- 路由参数 — 编译器从文件树产出 `manifest.routes`，运行时按模式匹配填 `context.params`；`:name` 与 `*` 捕获都支持。*demo 验证*
- KV Storage — `context.services.kv` → deis-store 的 `KvStore` 服务。*demo 验证*
- Cache API — `context.services.cache`，就是基础规范第 7 节那三个方法；
  `globalThis.caches.default` 仍然可用，且**指向同一个实例**。键接受字符串、`Request`
  和 `URL`。响应带 `Cache-Control: max-age` / `s-maxage` 就按它过期（`s-maxage` 优先），
  没带就用节点默认的 600 秒；带 `no-store` / `private` 的响应拒收并抛 `TypeError`，
  而不是悄悄存下来。`delete()` 如实回答有没有东西可删。
  **作用域是一个 Isolate**：同节点上同一个 (应用, 环境) 的后续请求读得到；换节点读不到，
  换版本（新 Isolate）也读不到。命中是优化，不是存放状态的地方。
  2026-08-29 之前这一格是错的，见下方更新日志。
- 生命周期 `waitUntil`
- 结构化日志 — `context.log.debug/info/warn/error()` 桥到 `console`，进环形缓冲，
  批量投递 deis-telemetry，可按应用查回。**三条路径都有**：请求、队列消费、cron
  （此前 `log` 只由 deis-build 生成的入口模块加在请求路径上，队列和 cron 的 handler
  拿到的 context 上根本没有 `log`）。*demo 验证（请求路径）*

**⚠️ 基础特性（有保留，这两格不要按 ✅ 规划）**:

- Request/Response — 用的是运行时自带的最小实现，不是 `deno_fetch` 的那套。
  已知缺口：主体只有文本（请求与响应体在 Isolate 边界上都是字符串，二进制过不去）；
  `Response` 没有 `Response.json()` 静态方法、没有 `ok` / `statusText` / `redirect`，
  也没有 `arrayBuffer()` / `blob()` / `formData()` 与流式主体。
  日常写法（`new Response(JSON.stringify(x), { status, headers })`、
  `await context.request.text()`）是通的。

- Web 标准 — **实际可用的全局比这一格看上去少得多**。`deno_web` / `deno_fetch` /
  `deno_crypto` / `deno_websocket` / `deno_net` 这几个扩展确实注册了（op 都在），
  但这些扩展的 JS 模块只 `export`、不往 `globalThis` 上挂东西，`deno_core` 自己也
  只挂一个 `console`，所以真正存在的全局只有运行时亲手装上去的那些。
  2026-08-29 用一个只做 `typeof globalThis[name]` 的探针应用实测：

  - **有**：`Headers`、`Request`、`Response`、`URL`、`URLSearchParams`、
    `EventTarget`、`setTimeout` / `clearTimeout`、`queueMicrotask`、`console`、
    `caches`、`WebSocketPair` / `WebSocketServer`、
    `TextEncoder` / `TextDecoder`、`atob` / `btoa`
  - **没有**：`fetch`、`crypto`、`AbortController`、`ReadableStream` /
    `WritableStream` / `TransformStream`、`setInterval` / `clearInterval`、
    `Blob`、`FormData`、`URLPattern`、客户端 `WebSocket`、`BroadcastChannel`、
    `MessageChannel`、`structuredClone`、`Event`、`performance`、`navigator`

  `TextEncoder` / `TextDecoder` / `atob` / `btoa` 是 2026-08-29 补上的（只做 UTF-8，
  其它编码名直接 `RangeError`，不冒充成 UTF-8 解）。补它们不是为了把格子填满：
  运行时自己有四处代码在调它们，因此一直抛 `ReferenceError`——
  `request.arrayBuffer()`、二进制请求体、`blob.put(key, "字符串")`、
  `blob.get(...).text()`，以及 WebSocket 的二进制帧解码。

  **`fetch` 不存在**这一条最要紧：Edge Canon 把它列进基础特性，而在 Deislet 上调它
  会直接 `ReferenceError`。

  这一格现在有测试守着：`crates/deis-runtime/src/runtime/isolate_test.rs` 的
  `the_isolate_global_surface_is_the_one_the_documents_describe` 在真 Isolate 里
  逐个 `typeof`，**两边都断言**——「有」的少一个红，「没有」的多一个也红，
  所以往 `globalThis` 上加东西必须连同本节和 `crates/deis-runtime/README.md` 一起改。

**✅ 扩展特性**:
- SQL Database — 每租户一个独立 SQLite，由 deis-store 通过 gRPC 提供。
  `query` / `execute` 可用。**`transaction` 不可用**：deis-store 每次调用落在连接池里
  任意一条连接上，没有能跨 `await` 持住 `BEGIN` 的会话，调用它会抛错。
  （此前它接下回调、不执行、直接 resolve——两条写入一条都没发生，调用方却以为成了。）
- Message Queues — deis-queue：租约式 `Pull`、`Ack` / `Nack` 带令牌、超限进死信。
  持久化在 SQLite，不是内存队列；单条消息体默认上限 1MB。*demo 验证*
- Cron Jobs — 控制面按 `(应用, 环境)` 调度，到点只在**一个**健康节点上触发。*demo 验证*
- WebAssembly — `WebAssembly` 全局是 V8 自带的，2026-08-29 用探针应用在真实 Isolate 里
  `new WebAssembly.Module(bytes)` + `new WebAssembly.Instance(m)` 实测通过。
  `import x from './math.wasm'` 这条链路（打包侧）没有端到端验证过
- Object Storage — `context.services.blob` → deis-store 的 Blob 服务（内容寻址落盘、
  Put/Get 分块流式）。`put` 收字符串、`ArrayBuffer` 与任意 `ArrayBufferView`，
  `get` 回一个有 `arrayBuffer()` / `text()` / `json()` 的对象，取不到的键回 `null`。
  2026-08-29 之前这一格是 ⚠️，因为 Isolate 侧两条路都断（`op_blob_put` 的入参声明成
  `#[serde] Vec<u8>`，serde_v8 不收定型数组；JS 侧又调不存在的 `TextEncoder`），
  且仓库里没有任何测试从 Isolate 出发调过它。现在两处都修好，并有
  `an_app_stores_and_reads_bytes_through_its_blob_binding` 顶着真 deis-store
  跑字符串与原始字节的往返

**平台自有能力（不在本矩阵范围内）**:
- 静态资产随版本包发布，命中即返回、不起 Isolate，带 ETag 并支持 `If-None-Match`。*demo 验证*
- 一个应用的每个环境是独立的部署与独立的存储租户；回滚是把环境指针移回去。*demo 验证*

**⚠️ 未验证**:
- WebSockets — 节点内部这一半现在有证据：Isolate 侧的 `WebSocketPair` 桥接有进程内
  测试，覆盖 HTTP 升级那一段的 `websocket_bridging_test.rs` 也已改成真测试——自己
  bind 端口起 router，用真 WebSocket 客户端连上去，断言 101 与两轮 echo 往返
  （此前它 POST 到写死的 localhost:8000，没服务就打印一行跳过并算通过）。
  仍未验证的是经过 deis-proxy 的那一跳。
  还有一条已经确定的缺口：客户端 `WebSocket` 这个全局不存在
  （`new WebSocket(...)` 直接 `ReferenceError`），只有服务端那一侧。
  二进制帧此前也会被当文本交付（解码用的 `atob` 不存在，异常被 `catch` 吞掉后
  `event.data` 留下的是原始 JSON 字符串）；`atob` 已经补上，但二进制帧这条路
  仍然没有测试走过，所以照旧算未验证。在补上测试之前不要按「可用」规划

**❌ 不支持（形态上没有，不是排期问题）**:
- Node.js Runtime — 运行时是裸 `deno_core`，没有注册 `deno_node`；`require`、`Buffer`、`node:` 模块都不存在，也不做 npm 包解析
- Server-Side Rendering / Incremental Static Regeneration — 没有框架挂钩，也没有 npm 生态可依赖
- Durable Objects — 每个节点跑全部应用，没有「唯一可寻址实例」这回事
- BroadcastChannel — 运行时没有把这个全局装到 `globalThis` 上，Isolate 之间也没有共享总线
- Workers AI

构建期能挡住的只有编译器**看得见**的那部分：项目在 `.config.json` 里声明的
`services.{database,blob,queue}`、`queues`、`cron`，以及 `runtime` 里带 `node` 字样。
这几样一旦落在目标平台的空白格上，`deis build` 直接失败并给出替代方案，不是告警放行。
其余几项（SSR、ISR、Durable Objects、BroadcastChannel、Workers AI）在项目配置里
没有可声明的地方，编译器也就无从检出——代码里用了它们，是在运行时才炸。

同样炸在运行时、编译器也拦不住的还有本节列出的几条保留：
`context.services.database.transaction(...)`、`fetch(...)`，以及上面「Web 标准」里
那一串不存在的全局。编译器只看某一格在目标平台上是不是空的，不看绑定本身通不通。

---

## 编译器验证机制

### 自动检测

`deis-build` 编译器会自动检测项目使用的扩展特性：

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
$ deis-build build --vendor tencent

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

- **2026-08-29（第三轮，整合期实测）**: 五条并行改动合流后重跑全部检查，顺手补上
  两处「文档说有、代码没有」的洞。
  - **编码全局转正**。`TextEncoder` / `TextDecoder` / `atob` / `btoa`（基础规范 8.1
    要求的四个）此前一个都不存在，而运行时自己有四处代码在调它们，于是
    `request.arrayBuffer()`、二进制请求体、`blob.put(key, "字符串")`、
    `blob.get(...).text()` 全都抛 `ReferenceError`。现已实现（只做 UTF-8，
    其它编码名 `RangeError`；`btoa` 拒收 Latin-1 之外的字符，`atob` 拒收非法 base64）。
  - **Object Storage 由 ⚠️ 转回 ✅**。除上面的编码全局外，`op_blob_put` 的入参从
    `#[serde] Vec<u8>` 改成 `#[buffer] JsBuffer`（serde_v8 不收定型数组），
    `op_blob_get` 改为返回 `ToJsBuffer`（原先回给 JS 的是逐字节的数字数组）。
    新增一条顶着真 deis-store 的 Isolate 端到端测试。
  - **全局清单从此有测试守着**。此前所有关于「有哪些全局」的结论都来自一次性探针，
    验完就撤；现在 `the_isolate_global_surface_is_the_one_the_documents_describe`
    在真 Isolate 里逐个 `typeof`，present 与 absent 两个清单都断言。
  - **canon 三项当场复验**（部署一个专写的应用走完整 demo 链路）：
    `scheduled(event, env, context)` 与 `queue(batch, env, context)` 的 `env` 确实落在
    第二个参数上；`message.ack()` 之后不再重投，`message.retry()` 之后
    `attempts` 从 1 变 2；`context.services.cache` 按第 7 节逐条通过。

- **2026-08-29（第二轮，实现 + 核对）**: 先把该做真的做真，再改文字。
  - **Cache API 转正**。基础规范第 7 节要求的 `context.services.cache` 此前**根本不存在**，
    只有 Cloudflare 风格的 `globalThis.caches`；而且那一个也是坏的——JS 用两个参数调
    只接受三个参数的 `op_cache_set`，每次 `put()` 都抛 `expected u32`，也就是说这个平台
    从来没有缓存过任何东西，此前那一格是错的。现在：装在 `context.services.cache` 上，
    `caches.default` 指向同一个实例；键支持字符串 / `Request` / `URL`（规范示例用的正是
    `new URL(...)`，而旧代码读它的 `.url`，会把每一条这样的记录都塞进键 `"undefined"`）；
    `Cache-Control` 的 `max-age` / `s-maxage` 真的决定过期；`no-store` / `private` 拒收；
    `delete()` 如实回答。
  - **handler 签名对齐**。扩展规范定义的是 `scheduled(event, env, context)` 与
    `queue(batch, env, context)`，运行时却只传两个参数，按规范写的 handler 会在 `env`
    的位置上拿到 context。现已改为三个，`deis-build` 生成的入口模块也照这三个参数
    转发。`message.ack()` / `retry()` 本来就有。
  - **`context.log` 补齐到三条路径**。此前只有 deis-build 生成的入口模块在请求路径上加，
    队列和 cron 的 handler 拿到的 context 上没有 `log`——而规范的 cron 示例第一行就在
    调 `context.log.info(...)`。
  - **降级：Object Storage 由 ✅ 改为 ⚠️**。服务端好的，Isolate 里的绑定两条路都断（详见
    上文该格）。**新增保留：`database.transaction` 不可用**，此前它接下回调、不执行、
    直接 resolve，现在改为抛错。
  - **同步修正 SPECIFICATION_EXT.md** 里比本矩阵更旧的 Deislet 格：队列由
    「Native (Memory) | ≤ 10MB」改为 deis-queue 的实际形态与 1MB 默认上限；SQL 由
    「PostgreSQL / MySQL」改为每租户 SQLite；对象存储 5GB 改为服务端 512MB 并标注保留；
    Node.js Runtime、SSR 由 ✅ 改为 ❌；BroadcastChannel 由 ✅ 改为 ❌；WebSockets 由 ✅
    改为 ⚠️。
- **2026-08-29**: 逐项回源码核对 Deislet 一列，能实测的都实测过。转正：路由参数、
  KV、SQL 数据库、对象存储、消息队列、定时任务。降级：**BroadcastChannel 由 ✅ 改为
  ❌**——用探针应用在真实 Isolate 里 `typeof` 过，这个全局根本不存在，此前那一格是
  错的；Node.js Runtime / SSR / ISR / Durable Objects 由 ⚠️ Planned 改为 ❌，它们不是
  排期问题，是形态上就没有。WebSockets 维持 ⚠️ 并写清楚未验证的是哪一段。同一次探针
  还发现基础特性里的 `fetch` 在 Deislet 上不存在，已写进 Web 标准那一格。
- **2026-08-28**: Deislet 一列中当时尚未实现的能力由 ✅ 降为 ⚠️ Planned。
- **2025-01-24**: 基于编译器 v0.1 平台能力验证系统创建。
- 数据来源：`deis-build-core/src/platform_capabilities.rs`

---

**注意**: 本矩阵与编译器实现保持同步。如发现不一致，以编译器验证结果为准。
