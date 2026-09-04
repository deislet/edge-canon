# EC-WEB provider adapter 协议 v1

本协议固定 conformance harness 与 Deislet、Cloudflare Workers/Pages、Tencent EdgeOne Makers 之间的执行边界。adapter 是测试传输层，不是另一套应用 API，也不是判定器；应用 fixture 始终相同，最终结论只由 `oracle.mjs` 产生。

## 调用方式

adapter 以非交互进程运行：

```text
node <adapter-entrypoint> --request <absolute-request-json-path>
```

request 必须符合 `schemas/conformance-provider-adapter-request.schema.json`。stdout 必须只有一行符合 `schemas/conformance-provider-adapter-result.schema.json` 的 JSON；诊断写 stderr，但同样必须脱敏和限长。退出码 `0` 只表示 `outcome=succeeded`。`failed` 或 `indeterminate` 必须非零退出。

操作固定为 `inspect → preflight → prepare → deploy → invoke → collect → cleanup`；`run` 按该顺序协调，并保证在任何后续失败后尝试 `cleanup`。各阶段含义如下：

- `inspect`：返回 adapter、协议和工具锁信息，不访问凭证或远端；
- `preflight`：核对精确工具版本、来源锁、凭证名和必要配置，不产生远端副作用；
- `prepare`：验证同一 canonical artifact 的完整文件树，再确定性生成供应商派生产物，记录两者摘要；此阶段不读取凭证、不运行供应商 CLI，也不产生远端副作用；
- `deploy`：部署隔离的短期测试版本，返回可恢复查询的 provider project/version/deployment identity；
- `invoke`：只执行统一 fixture 所要求的 HTTP、断连、并发和受控 origin 交互；
- `collect`：读取原始日志、CPU/限制计量、后台任务和 origin 证据，形成 observation 文档；
- `cleanup`：按本次 operation identity 删除短期部署与专属资源，不触碰预存资源；
- `run`：持久记录各阶段结果，协调全流程，并在失败后清理。

未实现的操作必须返回 `EC_ADAPTER_OPERATION_UNIMPLEMENTED`，不能成功空转。远端结果不明确时返回 `indeterminate`，随后按 provider identity 查询实际状态，不能盲目重试。

## 工具和凭证边界

每个 manifest 固定官方 CLI 的包名、精确版本和 registry integrity，或者固定 workspace binary 的版本与 40 位 source revision。adapter 必须直接执行绝对路径及参数数组，`shell=false`；不得从未知 `PATH` 接受同名工具。

凭证按操作从 manifest 列出的环境变量传入。凭证值不得出现在 request、argv、artifact、stdout、stderr、result 或 evidence reference 中。子进程仅继承当前操作所需的最小环境；输出按字节限长，超时终止整个进程树，并在持久化前按全部凭证值脱敏。

EdgeOne CLI 1.6.32 的 `makers deploy` 同时接受 `EDGEONE_PAGES_API_TOKEN` 环境变量和 `--json`，所以 CI adapter 不使用文档示例中的 `-t/--token` 参数。Cloudflare 使用 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 环境变量。Deislet 将部署凭证和管理凭证分别固定为 `DEIS_DEPLOY_TOKEN` 与 `DEIS_ADMIN_TOKEN`：部署子进程只能获得前者映射出的 `DEIS_CONTROL_TOKEN`，删除及完整节点卸载核验只使用后者；控制面 URL 是非秘密配置。

`requiredConfiguration` 和 `credentialEnvironment` 都按操作分别声明。`inspect` 不读取配置或凭证；`prepare` 只读取
`derivedDirectory`、`projectName` 和 `compatibilityDate`；凭证与工具锁只在实际需要它们的
操作读取。这样一次本地产物转换不会因为机器上没有部署凭证而失败，也不会把更大的权限
传给不需要它的进程。

`prepare` 还必须固定 `evidenceSinkUrl`、`controlledOriginUrl`、
`connectionBarrierOriginUrl` 与本机校准得到的 `cpuIterations`。三个 URL 只能是 HTTPS 或
本机回环 HTTP，不得含用户名、密码、query 或 fragment；它们是可审计的测试基础设施地址，
不是凭证。wrapper 只把这些固定值、`TEST_VALUE=edge-canon-env` 和 `EVIDENCE` 暴露到 fixture
的 `env`，不透传供应商原生 env 中未被标准声明的对象或账户信息。

## 产物谱系

`canonical-artifact.mjs` 从 `standardVersion` 所指 Git commit 直接读取统一 fixture 及其依赖，
而不是从可能有未提交修改的工作树复制。输出符合
`schemas/conformance-canonical-artifact.schema.json`：manifest 固定记录 exact standard commit、
suite、入口文件，以及按路径排序的每个文件的字节数和 SHA-256。request 中的
`canonicalArtifact.sha256` 是该 manifest 精确 JSON 字节的 SHA-256。

`prepare` 首先核对 manifest 摘要、全部逐文件摘要、文件集合和路径安全性；符号链接、目录
逃逸、额外文件、缺失文件或摘要不符均失败。canonical、derived 与 evidence 三棵目录不得
互相包含，避免一次转换污染下一次完整性复核或把可部署代码混入证据。之后在
`workDirectory` 内以临时目录完整写入，
再原子重命名成 `derivedDirectory`。派生 manifest 符合
`schemas/conformance-derived-artifact.schema.json`，固定 backend、标准版本、canonical 摘要、
项目名、兼容日期、入口和全部派生文件摘要。相同输入重复执行只接受逐字节一致的现有目录；
存在任何差异时返回冲突，不覆盖已有内容。

三个派生项目都原样携带 canonical fixture 和依赖，只增加标准 context 到供应商原生入口的
薄适配层。Cloudflare 生成 module Worker 与 `wrangler.json`；EdgeOne 生成官方文件路由
`edge-functions/[[default]].js`；Deislet 生成标准 catch-all 路由 `functions/[[all]].js` 与
`.config.json`。适配层把 `request`、`env`、`params` 和 `waitUntil` 组成同一个四键 context，
`EVIDENCE.record` 只产生带固定前缀的结构化日志，供后续 `collect` 收集，不能参与 oracle 判定。
同一层还实现标准而非供应商自行决定的运行边界：同步抛出、Promise 拒绝和非 `Response` 返回
被转换为固定非泄漏 500；每个 `waitUntil` Promise 独立跟踪拒绝；响应 body 关闭、报错或取消时
关闭前台生命周期；关闭后的 `waitUntil` 同步抛出带 `EC_WAIT_UNTIL_CLOSED` 的 `TypeError`。
日志只记录稳定代码、operation invocation ID 和有界 fixture marker，不记录异常消息或栈。
对于不能可靠读取边缘函数日志的后端，wrapper 同时把相同结构记录发送到派生产物中固定的
`evidenceSinkUrl`。一次性 `EDGE_CANON_EVIDENCE_TOKEN` 只由 `invoke` 作为
`x-edge-canon-evidence-token` 请求头送达，不进入 request JSON、argv 或产物；sink URL 不能由
调用者改写。`x-edge-canon-invocation-id`、令牌头和证据模式头在创建标准 `Request` 前全部
移除。CPU、50 子请求和 6 外连三个资源边界用例使用 `x-edge-canon-evidence-mode: off`，避免
adapter 自己的日志和 sink 子请求污染被测 CPU 或网络预算；这三个用例只采用 HTTP、受控 origin、
barrier 与后端计量的独立证据。

## 部署身份和恢复

每个部署名称只能由 `backendId + operationId` 确定性生成，格式为
`edge-canon-{cf|eo|deis}-<16 位摘要>`；request 必须精确使用 `inspect` 返回的名称。adapter 在任何
远端写入前，以供应商公开 API 查询同名资源并拒绝碰撞，不能覆盖既有项目。经过复核的派生产物
会复制到本次 operation 独占的可变目录，因为供应商 CLI 可能写入当前目录；canonical 与 derived
目录始终保持不可变。

部署状态符合 `schemas/conformance-provider-deployment-state.schema.json`，以 `0600` 原子持久化并
同时绑定 operation、标准 commit、canonical/derived 摘要、项目名及供应商 project、deployment、
version 和 URL。调用供应商工具前必须先记录 `deploying`；超时、输出超限、异常退出或无法核验
供应商身份时记录 `deploy-indeterminate`，相同 operation 之后只能进入显式核对或清理，不能再次
执行部署命令。

同一 operation 的部署与清理共用排他操作锁。活跃进程持锁时并发调用返回
`EC_ADAPTER_OPERATION_BUSY`；同一主机进程已消失的锁可以安全回收。若崩溃发生在派生产物复制后、
状态持久化前，只有当现有可变目录的完整树与已复核 derived 目录逐项一致时才能继续。清理先按
持久化身份复查资源，再删除且再次验证不存在；结果不明确的清理同样不能盲目重放。Deislet 只有
在 Control 删除回执确认全部节点卸载成功后才视为完成。EdgeOne CLI 1.6.32 和已确认的公开 API
尚未提供非交互项目删除契约，因此其 cleanup 必须继续标为 pending，不能调用未公开接口冒充实现。

`invoke` 与部署、清理共用同一把 operation 锁，并在第一个被测 HTTP 请求前建立符合
`schemas/conformance-provider-invocation-state.schema.json` 的 `0600` 状态。状态绑定部署 identity
摘要、两级产物摘要、精确标准版本及固定调用计划。每个步骤先把 `currentStep` 原子落盘，再发请求；
有界原始交换随后追加到 `0600` NDJSON 并 `fsync`，最后才推进完成前缀。只要进程在请求发出后未能
证明完整响应，状态就进入 `invoke-indeterminate`；相同 operation 不得重发这个或后续 handler 请求。
完成态同时固定整份 NDJSON 的 SHA-256，重复调用只复核并返回原证据。

调用目标只能来自已核验 deployment state，不能由调用者另给 URL。Deislet 额外用同一 state 中的
项目名及环境产生平台路由头；测试令牌和 invocation identity 是 adapter 传输头，wrapper 在构造应用
`Request` 前删除。每个响应采用覆盖 headers 与 body 的总 deadline、大小上限和手动 redirect 策略；
原始证据只保存允许列出的响应头、body 摘要/有界字节和读取片段长度，不保存请求令牌。

T012 必须是新部署收到的首个 handler 请求。T009 不得假设连续请求落在同一 isolate：fixture 在
一次请求内先登记保活任务，响应生命周期关闭后由该任务尝试迟到注册，并以同一 invocation 的失败码
和 marker 证明同步 `TypeError`。T007 记录网络读取片段但最终按协议哨兵重建应用 chunk，不能把 HTTP
传输分片误当 `ReadableStream.enqueue` 边界。T010 读取第一段后主动 cancel，再以独立 invocation
执行 probe。

受控 origin 和连接 barrier 共用以下 provider-neutral 管理路径；管理请求必须携带同一一次性
`EDGE_CANON_EVIDENCE_TOKEN`，应用请求不知道管理凭证：

- `POST /__edge-canon/control/origin/reset` 与 `GET /__edge-canon/control/origin/status`；
- `POST /__edge-canon/control/barrier/reset`、`GET /__edge-canon/control/barrier/status` 与
  `POST /__edge-canon/control/barrier/release`。

origin status 至少返回 `totalRequestCount`；barrier status 返回互不重复、范围为 0–6 的
`waitingSlots`、`startedSlots`、`cancelledSlots`。T014 只有在独立控制面已经观察到至少六条连接等待
响应头后才释放 barrier。管理面或网络结果不确定同样使本次 invoke 不可重放。

## 证据和完成条件

`evidenceDirectory` 必须是本次 operation 独占目录，证据文件使用 `0600`，引用只能指向该目录内的不可变文件或访问受控的远端记录。adapter 输出原始 observation，不增加 `pass`、`compliant` 或 semantic waiver。

manifest 为 `complete` 的必要条件是：八个操作均为 `implemented`、该 suite 全部用例均为 `implemented` 且无 blocker、三个 adapter 都通过真实测试账户运行，并能把 exact standard commit、canonical/derived artifact digest、provider deployment identity 和原始执行证据关联起来。仅完成 inspect/preflight 或本地 mock 仍是 `draft`。
