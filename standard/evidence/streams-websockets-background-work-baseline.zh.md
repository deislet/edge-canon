# Streams、WebSocket 与后台任务行业证据基线

- 核对日期：2026-09-04
- 参考供应商：Cloudflare Workers/Pages、Tencent EdgeOne/EdgeOne Makers
- 政策：只采用两个参考供应商最低公开产品面均可兑现的共同语义；未公开的保证阻断发布，不以本地实现或更高付费档补齐。

## 上游标准

- [WHATWG Streams Living Standard](https://streams.spec.whatwg.org/) 定义 readable/writable stream、reader/writer lock、pipe、tee、cancel、backpressure 和错误传播；
- [WHATWG WebSockets Living Standard](https://websockets.spec.whatwg.org/) 定义客户端 `WebSocket` 连接、消息与关闭语义。它不自行证明任一边缘运行时可以终止入站 WebSocket；
- `waitUntil` 是边缘运行时生命周期 API，不是 WHATWG Streams/WebSockets 的组成部分，必须依据参考供应商公开契约另行收敛。

## 供应商事实

| 能力 | Cloudflare Workers/Pages | Tencent EdgeOne/EdgeOne Makers | Edge Canon 结论 |
| --- | --- | --- | --- |
| 流式 Request/Response body | [Streams API](https://developers.cloudflare.com/workers/runtime-apis/streams/) 允许直接流式返回，响应 body 结束或客户端断开前 invocation 保持活动 | [ReadableStream](https://edgeone.ai/document/52695)、[TransformStream](https://edgeone.ai/document/52698) 与[流式响应示例](https://edgeone.ai/document/52712)公开相同用途 | 纳入共同应用面 |
| Readable/Writable 直接 constructor | Cloudflare 文档公开标准 Streams 类型，但运行时上下文和兼容日期会影响实现 | EdgeOne 明确写明 `ReadableStream`、`WritableStream` 不能直接构造，只能从 `TransformStream` 取得 | v1 不保证直接 constructor |
| TransformStream transformer | Cloudflare 当前文档说明其实现尚未完全符合 Streams Standard，当前 `TransformStream` 是 identity transform | EdgeOne 接受 transformer 参数但明确忽略 | 只保证无参数 identity transform；传 transformer 必须在部署前拒绝，不能静默忽略 |
| Readable/Writable instance 操作 | Cloudflare 公开 reader、writer、pipe 与 lock 操作 | EdgeOne 公开 `getReader`、`pipeTo`、`pipeThrough`、`tee`、`cancel`、`getWriter`、`write`、`close`、`abort` 等 | 选取共同实例子集 |
| `waitUntil` | [Context](https://developers.cloudflare.com/workers/runtime-apis/context/) 允许多次登记，按 all-settled 独立执行；响应或断开后最多延长 30 秒 | [FetchEvent](https://edgeone.ai/document/52688) 只公开以 Promise 延长生命周期，没有公开宽限、数量或取消细节 | API、多任务隔离和 best-effort 语义进入 Draft；没有共同时长/数量保证 |
| WebSocket 边缘函数终止 | [Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/) 提供 `WebSocketPair`、accept/send/close 和入站消息 32 MiB 限制 | [EdgeOne WebSocket](https://edgeone.ai/document/46971) 是客户端到源站的 CDN 协议代理，Edge Functions Runtime API 目录没有 `WebSocket`/`WebSocketPair` | 没有可移植运行时交集；应用引用必须预部署失败，不能落到 Cloudflare 专有分支 |

## 最低资源候选

EdgeOne 公开的 `TransformStream` writable 默认 high-water mark 为 32 KiB、最大 256 KiB；Cloudflare 明确支持使用 Streams 在 128 MB 内处理远大于内存的 body。两者都没有以相同口径公布单 chunk、未消费分支缓存或流式响应总字节下限。本 Draft 因而只把 **65,536 octet、每次最多 4,096 octet、写入方一次最多等待一个未结算 write** 作为 conformance 正向候选；它需要在两个真实供应商和 Deislet 上通过压力 fixture 后才能冻结。

后台任务没有共同的公开宽限、数量、内存或可靠交付保证。应用只能依赖已登记 Promise 被 best-effort 跟踪；拒绝不取消同一 invocation 的其他任务，也不会自动重试。需要可靠投递、持久重试或超过共同宽限的工作必须使用未来 `queue-schedule-service-binding` 能力族，不能把 `waitUntil` 当作队列。

## 发布阻断项

1. 在 Cloudflare、EdgeOne 与 Deislet 真实运行 64 KiB、背压、取消、错误、tee、流式响应和客户端断开测试；
2. 取得 EdgeOne 公开的后台宽限、取消和超限结果，或保留这些资源维度为明确的无保证；
3. 证明 provider packager 会拒绝 transformer callback、直接 constructor 与 WebSocket 引用，而不是由供应商静默忽略或只在部分平台运行；
4. 若未来 EdgeOne Edge Functions 提供 WebSocket 终止 API，重新比较握手、消息类型/大小、背压、close、异常断线和升级语义，发布新标准版本；
5. 冻结流式请求/响应总量、单 chunk、未消费 tee 分支和断开后的共同资源行为。

## Reference portability evidence

2026-09-04 的 Linux、macOS 与 Windows 同源执行结果保存在 [`streams-websockets-background-work-platforms-2026-09-04.json`](../../conformance/evidence/streams-websockets-background-work-platforms-2026-09-04.json)。三套环境均通过 13 个 Draft case，并生成同一 capability-lock identity。该记录只证明 reference harness 的可移植性，不是 Cloudflare、EdgeOne 或 Deislet runtime 的合规证据。

真实后端的第一阶段运行时证据按 [`provider-runtime-protocol.zh.md`](../../conformance/harness/streams-websockets-background-work/provider-runtime-protocol.zh.md) 采集。该协议固定同一份无供应商分支的应用夹具、两个并发 invocation、流式响应时序和 64 KiB 响应摘要；当前判定名称明确为 `runtime-partial-pass`，剩余生命周期、背压、取消与构建拒绝断言必须继续单独补齐。
