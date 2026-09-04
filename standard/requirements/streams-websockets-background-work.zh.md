# Streams、WebSocket 与后台任务候选要求

- 标准：`edge-canon.next`
- 能力族：`streams-websockets-background-work`
- 状态：Draft Candidate
- 规范效力：无；仅在 Proposal 0001 晋级并发布后生效
- 最后核对参考实现：2026-09-04

本草案固定 Cloudflare Workers/Pages 与 Tencent EdgeOne/EdgeOne Makers 当前共同具备的流式 body 和后台任务语义。应用仍面对一个标准；供应商原生差异由 packager/runtime 收敛，不产生 profile。完整 capability lock 由 [`streams-websockets-background-work.schema.json`](../../schemas/streams-websockets-background-work.schema.json) 约束，行业事实记录在[证据基线](../evidence/streams-websockets-background-work-baseline.zh.md)。

WebSocket 的结论同样属于标准：截至基线日期，Cloudflare 能在 Worker 内终止连接，EdgeOne 只公开 CDN 到源站的 WebSocket 代理，没有 Edge Functions `WebSocket`/`WebSocketPair` API。它不是共同应用能力；编译器必须拒绝非可移植引用，不能让应用按 provider 分支。标准以后可以随行业共同面演进，但不会追溯改变已发布版本。

## 1. API

- **EC-STREAM-API-001**：`new TransformStream()` 必须产生无参数 identity byte transform，公开互相关联的 `readable` 和 `writable`。v1 不接受 transformer 或自定义 queuing strategy；供应商原生忽略参数时，packager 必须先拒绝。
- **EC-STREAM-API-002**：从 Request/Response body 或 TransformStream 得到的 `ReadableStream` 必须提供 `locked`、`getReader()`、`pipeTo()`、`pipeThrough()`、`tee()` 和 `cancel()`；default reader 必须提供 `closed`、`read()`、`cancel()` 与 `releaseLock()`。v1 不要求应用直接调用 `new ReadableStream()` 或 BYOB reader。
- **EC-STREAM-API-003**：从 TransformStream 得到的 `WritableStream` 必须提供 `locked`、`getWriter()`、`close()` 和 `abort()`；default writer 必须提供 `closed`、`ready`、`desiredSize`、`write()`、`close()`、`abort()` 与 `releaseLock()`。v1 不要求应用直接调用 `new WritableStream()`。
- **EC-STREAM-API-004**：标准 stream body 的应用可写 chunk 只接受 `Uint8Array`；读取必须以 `{value: Uint8Array, done: false}` 返回每个 chunk，并最终返回 `{value: undefined, done: true}`。字符串、对象和供应商专有 blob chunk 不能成为隐式共同语义。
- **EC-STREAM-API-005**：Request/Response 必须接受标准 readable byte stream body；handler 返回 Response 后，body 可以继续按产生顺序传输，无需先完整缓冲。HEAD/null-body 约束仍由 Web Platform APIs 与 Fetch 语义决定。
- **EC-STREAM-API-006**：调用 context 的 `waitUntil(promise)` 必须登记 Promise 为该 invocation 的后台工作；允许多次登记，所有已登记任务按独立 all-settled 集合跟踪。它不返回任务结果，也不提供持久队列语义。
- **EC-STREAM-API-007**：本版本不提供应用可用的 `WebSocket`、`WebSocketPair`、server accept 或 provider WebSocket handle。源码、canonical artifact 或依赖图一旦引用这些 API，必须以 `EC_STREAM_WEBSOCKET_NONPORTABLE` 在部署前失败。“引用”以解析 TypeScript 类型和词法作用域后的运行时语义为准：未绑定的同名全局、`globalThis` / `self` 的同名静态属性及其解构读取属于引用；注释、字符串、擦除后的类型以及本地定义或导入的同名 binding 不属于引用。packager 必须把 AST 分析结果交给策略验证器，不能以源码文本正则替代作用域解析。

## 2. 错误

- **EC-STREAM-ERR-001**：已 locked 的 readable 再 `getReader()`、已 locked 的 writable 再 `getWriter()`，以及对失去 lock 的 reader/writer 继续操作，必须同步抛出或返回以 `TypeError` 拒绝的 Promise，严格服从对应 WHATWG 操作形态。
- **EC-STREAM-ERR-002**：source error 必须使待处理/后续 read 与 reader `closed` 拒绝；sink error 必须使 write/pipe 与 writer `closed` 拒绝。不得把 error 改写成正常 EOF、空 body 或成功 close。
- **EC-STREAM-ERR-003**：向标准 identity transform 写入非 `Uint8Array` 必须以 `TypeError` 和稳定代码 `EC_STREAM_CHUNK_TYPE` 失败；失败后不得发送该值的字符串化结果。
- **EC-STREAM-ERR-004**：`waitUntil` 传入非 Promise/thenable 或前台生命周期关闭后登记，必须同步抛出 `TypeError`，稳定代码分别为 `EC_WAIT_UNTIL_PROMISE_REQUIRED` 与 `EC_WAIT_UNTIL_CLOSED`。

## 3. 并发、一致性与顺序

- **EC-STREAM-CON-001**：同一 stream 的 chunk 按成功 write/enqueue 顺序读取；任何两个 chunk 不得互相插入字节、重复或跨 invocation 串线。writer 对同一 writable 的写入按调用顺序串行完成。
- **EC-STREAM-CON-002**：`write()`、writer `ready`、`pipeTo()` 与 underlying sink Promise 必须传播背压；生产方不得把未结算 write 当作已完成，也不得因为供应商缓冲较大就绕过顺序和内存上限。
- **EC-STREAM-CON-003**：`tee()` 返回两个可独立读取的分支，两个分支观察相同有序数据；任一分支的 reader/lock/bodyUsed 状态不得直接改变另一分支。未消费分支的无界缓存不属于保证。
- **EC-STREAM-CON-004**：多个 `waitUntil` Promise 可以任意顺序结算；一个任务的拒绝不得取消其他任务，集合结果必须按登记项保持关联。后台任务不得在不同 invocation 之间共享登记集合。

## 4. 生命周期

- **EC-STREAM-LIFE-001**：handler Promise 结算不等于前台生命周期结束；返回 Response 的 body 正常 close、error 或因客户端断开 cancel 时，前台生命周期才关闭。实现必须在此之前维持完成流式传输所需的执行上下文。
- **EC-STREAM-LIFE-002**：stream 只能进入一次终态 close、error 或 cancel。终态之后的 write/enqueue 不得重新打开 stream；cancel 必须通知 underlying source，abort 必须通知 underlying sink，pipe 必须按选项传播终态。
- **EC-STREAM-LIFE-003**：前台生命周期关闭后，仅先前通过 `waitUntil` 登记的任务可继续到平台宽限结束；新登记被拒绝。全部任务结算或平台终止后后台集合关闭，context 不得复用于另一 invocation。

## 5. 最低资源保证

- **EC-STREAM-LIMIT-001**：实现必须能以不超过 4,096 octet 的 `Uint8Array` chunk、生产方一次最多等待一个未结算 write，顺序传输至少 65,536 octet 的单个 Response body。应用不得由此推断更大的总量、单 chunk、tee 缓冲、后台宽限或任务数可移植；这些边界仍阻断冻结。

## 6. 安全与隔离

- **EC-STREAM-SEC-001**：客户端断开、consumer cancel 或 AbortSignal 终止 pipe 时，取消必须传播到关联 source/sink，并停止继续读取或发送；不得把断开的响应 body 在后台无界排空到内存。
- **EC-STREAM-SEC-002**：stream controller、reader、writer、chunk、error reason 与后台集合都属于创建它的 invocation/对象图；运行时不得向并发或后续 invocation 泄漏数据、错误或任务句柄。
- **EC-STREAM-SEC-003**：provider packager 可以内部使用供应商 stream/WebSocket primitives 实现标准，但不得把 Cloudflare `WebSocketPair`、EdgeOne origin proxy handle 或专有 stream 类型暴露给应用，也不得把 provider 探测注入应用源码。

## 7. 失败与恢复

- **EC-STREAM-FAIL-001**：响应尚未提交时的 stream 构造失败可转为标准非泄漏 500；响应已提交后的 body error/cancel 必须终止 transport 并记录明确终态，不能用第二个 HTTP 响应、供应商错误页或成功 EOF掩盖。
- **EC-STREAM-FAIL-002**：`waitUntil` task 拒绝不改变已经产生的 HTTP 响应、不取消其他 task，也不触发隐式重试；错误必须进入标准可观测性通道，且不得向客户端泄漏内部异常文本。
- **EC-STREAM-FAIL-003**：进程崩溃、节点回收、平台宽限结束或部署切换可以丢失未完成后台任务；本 API 不承诺 at-least-once、exactly-once 或恢复。要求可靠交付的应用必须使用标准 queue/schedule 能力。

## 8. 升级与迁移

- **EC-STREAM-UPG-001**：capability lock 必须包含受支持 major、精确 Edge Canon commit 和上游基线日期；未知 major、浮动版本、未知字段与改变 WebSocket policy 的输入必须在执行应用前拒绝。
- **EC-STREAM-UPG-002**：provider packager 必须从 lock 派生 identity transform、context-bound `waitUntil` 与 WebSocket 拒绝策略；账户默认值、兼容日期、EdgeOne 静默忽略 transformer 或 Cloudflare 新增 API 均不得扩大应用面。
- **EC-STREAM-UPG-003**：引入标准 transformer、direct constructor、BYOB、Compression Streams、WebSocket 或可靠后台工作必须发布新 Edge Canon 版本、扩充 oracle 并提供迁移诊断；已发布 v1 的拒绝规则保持不变。

## 9. 晋级条件

进入 `normative-complete` 前仍需：

1. 三个一等后端真实执行全部 EC-STREAM cases，包括客户端断开、背压、已提交错误和 64 KiB 边界；
2. 将 64 KiB 正向候选提升为有供应商证据的冻结下限，或重新选择两个参考供应商均明确公开的数值；
3. 对后台宽限、数量、取消和部署切换建立共同契约；没有共同公开数值时必须保留无保证并证明失败行为；
4. 三个 provider packager 对 transformer、direct constructor 与 WebSocket 的预部署拒绝完成审计；
5. 行业共同提供边缘函数 WebSocket 终止能力后，另发版本定义握手、消息、背压、close、资源与恢复语义；在此之前不能把 Cloudflare 专有能力写进标准应用。
