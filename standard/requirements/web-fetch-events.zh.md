# Web Fetch Events 候选要求

- 标准：`edge-canon.next`
- 能力族：`web-fetch-events`
- 状态：Draft Candidate
- 规范效力：无；仅在 Proposal 0001 晋级并发布后生效
- 最后核对参考实现：2026-09-03

本文把 HTTP 请求入口的行业共同语义整理为带稳定标识的候选条款。文中的“必须”“不得”描述候选标准行为，不代表当前实现已经合规。`minimum-resource-guarantees` 尚未完整定义，因此本能力族不能进入 `normative-complete`，任何后端也不能据此获得 `edge-canon.next` 合规声明。

## 1. 参考边界

本草案参考以下官方材料：

- [Cloudflare Workers Fetch handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/)：模块 worker 的请求入口、`request`、`env` 与执行上下文；
- [Cloudflare Workers Context](https://developers.cloudflare.com/workers/runtime-apis/context/)：`waitUntil()` 的多任务、结算与响应后生命周期；
- [Cloudflare Pages Functions API](https://developers.cloudflare.com/pages/functions/api-reference/) 与 [Get started](https://developers.cloudflare.com/pages/functions/get-started/)：`onRequest(context)`、路由参数与方法入口；
- [Tencent EdgeOne Pages Edge Functions](https://pages.edgeone.ai/document/edge-functions) 与 [Edge Functions 概览](https://edgeone.ai/document/162227908259442688)：文件路由、默认 `onRequest(context)` 与上下文字段；
- [Tencent EdgeOne FetchEvent](https://edgeone.ai/document/52688)：经典事件入口、`respondWith()`、`waitUntil()` 与异常透传行为；
- [WHATWG Fetch Standard](https://fetch.spec.whatwg.org/)：`Request`、`Response`、body 与 abort 的上游 Web 语义。

Cloudflare Workers 的对象式 `fetch(request, env, ctx)`、Cloudflare Pages 的具名 `onRequest(context)`、EdgeOne Makers 的默认函数及 EdgeOne 经典 `FetchEvent` 是后端适配输入，不是多个应用 profile。Edge Canon 应用只面向本文件定义的单一入口；编译器负责生成恰当的原生包装。

## 2. 候选类型

```ts
interface RequestContext {
  readonly request: Request;
  readonly env: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, string>>;
  waitUntil(promise: Promise<unknown>): void;
}

type RequestHandler =
  (context: RequestContext) => Response | Promise<Response>;
```

`env` 中值的具体类型与授权由 `environment-secrets`、`logical-resource-bindings` 等能力族定义；本能力族只固定字段存在和按调用注入。`Request`/`Response` 的精确子集由 `web-platform-apis` 定义。在这些依赖完成前，本节不是完整 ABI。

## 3. API

- **EC-WEB-API-001**：每个被路由到的函数模块必须有且仅有一个默认导出的 `RequestHandler`。缺少入口、入口不可调用或存在第二种 HTTP 入口语义时，构建必须在生成供应商产物前失败。
- **EC-WEB-API-002**：标准入口必须接收一个 `RequestContext`，并返回 `Response` 或最终兑现为 `Response` 的 Promise。同步与异步 handler 的可观察结果必须一致。
- **EC-WEB-API-003**：每次调用的上下文必须提供 `request`、`env`、`params` 和 `waitUntil`。缺失字段不得由应用通过供应商全局对象补取。
- **EC-WEB-API-004**：同一个入口必须处理所有 HTTP 方法，应用通过 `context.request.method` 分派。供应商的方法专用导出只可作为编译器生成的后端适配代码，不能成为标准应用源代码的替代入口。
- **EC-WEB-API-005**：`request`、有效返回值及其 body 必须服从该应用锁定版本所引用的 `web-platform-apis` Fetch 子集。后端不得静默替换为供应商专有 Request/Response 类型。

## 4. 错误

标准错误响应候选值为：状态 `500`，`Content-Type: text/plain; charset=utf-8`，`Cache-Control: no-store`，body 为 UTF-8 字节串 `Internal Server Error\n`。失败代码进入结构化执行证据，不进入响应正文。

- **EC-WEB-ERR-001**：handler 同步抛出或其 Promise 拒绝时，尚未发送响应的调用必须得到标准错误响应，并记录失败代码 `EC_HANDLER_THROWN`。异常消息、栈、供应商请求标识和环境值不得泄漏到标准错误响应。
- **EC-WEB-ERR-002**：handler 正常完成但结果不是 `Response` 时，调用必须得到标准错误响应，并记录失败代码 `EC_HANDLER_RESULT_INVALID`。
- **EC-WEB-ERR-003**：标准默认行为不得因 handler 异常而隐式回源、继续执行供应商链或采用供应商自定义错误页。未来若标准定义显式 fail-open，它必须是版本化 API，而不是后端差异。

## 5. 并发、一致性与顺序

- **EC-WEB-CON-001**：后端可以并发执行同一部署的多个请求；标准不提供请求间串行、先到先执行或完成顺序保证。
- **EC-WEB-CON-002**：模块级可变内存不是协调、持久化或跨调用通信机制。后端可以复用、并行复制或随时丢弃实例；需要有序或持久状态的应用必须使用相应标准能力。

## 6. 生命周期

“前台生命周期”从上下文创建开始，持续到 handler 结算以及返回的响应 body 正常关闭、报错或被取消；无 body 的响应在 handler 结算后结束。“后台集合”是生命周期关闭前传给 `waitUntil` 的全部 Promise。

- **EC-WEB-LIFE-001**：后端必须允许响应 body 在 handler 返回后继续产生数据；不得仅因 handler Promise 已兑现就截断尚未结束的标准响应流。
- **EC-WEB-LIFE-002**：一次调用可以多次调用 `waitUntil`。每个参数必须加入同一后台集合，单个 Promise 的拒绝不得取消集合中的其他 Promise。
- **EC-WEB-LIFE-003**：后台 Promise 的拒绝必须记录为该调用的后台失败证据，稳定失败代码为 `EC_BACKGROUND_REJECTED`；它不得改变已经产生的 HTTP 响应，也不得转化为 handler 的隐式重试。
- **EC-WEB-LIFE-004**：`waitUntil` 只在前台生命周期关闭前接受新 Promise。关闭后的调用必须同步抛出 `TypeError`，并带稳定失败代码 `EC_WAIT_UNTIL_CLOSED`；不得无声丢弃任务。

后台集合能继续多长时间属于最低资源保证，本草案尚未规定。因此“接受任务”不等同于无限执行保证。

## 7. 最低资源保证（Draft，仍阻断发布）

- **EC-WEB-LIMIT-001**：一次 HTTP 调用必须获得至少 10 ms 应用 CPU 执行预算；等待网络、存储或其他异步 I/O 的时间不得计入该预算。10 ms 是应用可依赖的最低值，不是超出后仍会继续执行的保证；偶发宽限和更高套餐预算不进入标准语义。conformance 必须同时读取后端计量证据，不能用 wall time 猜测 CPU。
- **EC-WEB-LIMIT-002**：在不存在网络、权限或目标服务失败时，一次调用必须允许前 50 次外部 `fetch` 子请求开始执行。一次重定向跳转计作一次新的子请求。应用不得依赖第 51 次及以后的调用能执行。
- **EC-WEB-LIMIT-003**：一次调用必须允许至少 6 个外部 `fetch` 同时处于等待响应头状态。超过该数值的请求可以排队，但不得取消、改写或抢占前 6 个请求；应用不得依赖第 7 个请求立即开始连接。
- **EC-WEB-LIMIT-004**：对于没有 `Content-Encoding`、带准确 `Content-Length: 1000000` 且 body 恰为 1,000,000 octet 的 HTTP 请求，后端必须进入 handler，并允许应用通过锁定 Fetch 子集完整读取全部 body octet，顺序和值不得改变。该下限不包含 header 或传输分帧开销，也不提前规定压缩、chunked、未知长度或超过下限时的处理。

这四条已有两家参考产品的官方数值交集，因此从 `pending` 进入 Draft；它们仍需三个一等后端的压力与故障 fixture，且不能把供应商原生错误页当成标准错误。

当前公开事实与空白已记录在[最低资源保证证据基线](../evidence/web-fetch-events-resource-baseline.zh.md)。基线政策已经确定：取每个参考供应商面向一般用户开放的最低免费档或入门档共同可兑现的保证，不允许用更高付费档抬高标准。T015 只冻结 identity、已知长度、恰为 1,000,000 octet 的正向读取保证；压缩/chunked/未知长度、超过下限、响应 body、HTTP wall time、应用可用内存归属、`waitUntil` 宽限及超限后已开始响应流的处理仍未解决，所以本维度继续阻断发布。

## 8. 安全与隔离

- **EC-WEB-SEC-001**：每次调用必须获得独立的上下文对象。后端不得把另一调用的 `request`、`params`、未授权 `env` 值或生命周期任务混入当前上下文。
- **EC-WEB-SEC-002**：除已由锁定标准版本定义的字段外，后端不得通过标准上下文暴露供应商对象、账户/租户标识、凭证、原生资源 ID 或控制面能力。

## 9. 失败与恢复

- **EC-WEB-FAIL-001**：HTTP handler 在已经开始执行后不得由标准运行时自动重跑。传输重试、供应商内部调度和客户端重试不得表现为同一调用的第二次应用执行；应用必须自行设计跨调用幂等性。
- **EC-WEB-FAIL-002**：客户端断开不构成应用事务回滚，也不保证取消已登记的后台集合。后端可以取消尚未消费的响应 body，但取消必须局限于当前调用，不得污染或终止后续调用。

客户端断开能否通过 `request.signal` 观察，由 `web-platform-apis` 的 Fetch 子集决定；本条不提前承诺该 API。

## 10. 升级与迁移

- **EC-WEB-UPG-001**：canonical artifact 必须锁定精确 Edge Canon 版本；编译器和后端不得按当前供应商能力、地区或日期改变本能力族语义。
- **EC-WEB-UPG-002**：已发布版本中的条款语义不可原地改变。行业演进通过新标准版本和显式迁移产生；同一应用版本在三个一等后端上必须继续接受同一套 oracle。

## 11. 未决项与晋级条件

本草案进入 `normative-complete` 前至少还需：

1. 完成其余 `minimum-resource-guarantees` 空白，并用三个后端的压力/故障 fixture 验证现有 Draft 下限、body 变体及超限行为；
2. 完成所引用的 `web-platform-apis`、`environment-secrets`、`logical-resource-bindings` 与 canonical artifact 类型；
3. 将当前机器可读用例实现为可在三个一等后端运行的同源 fixture 和 provider-independent oracle；
4. 用真实部署验证错误响应、流式生命周期、后台集合和断连隔离，不以本地 mock 代替；
5. 由至少两个独立实现审阅 ABI 与适配可行性。
