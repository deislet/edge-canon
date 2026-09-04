# EC-WEB 可执行 harness 草案

本目录把描述性用例推进为一个可执行、供应商无关的 observation/oracle 边界。当前 fixture/oracle 已覆盖 `EC-WEB-T001` 至 `T015`，状态仍是 Draft；三个 adapter 已实现受约束的 `inspect`、`preflight`、确定性 `prepare`、身份绑定 `deploy` 与统一的 at-most-once `invoke`，Cloudflare 和 Deislet 还实现了可核验 `collect`、`cleanup` 和可恢复的全流程 `run`。仓库同时提供了带持久化证据 sink、受控 origin 和连接 barrier 的认证 harness service，以及把这些原始事实确定性转换为 observation 的 provider-neutral collector；Cloudflare `collect` 已接入按 Ray ID 查询的单次 invocation CPU 证据，Deislet `collect` 已接入按平台盖章 trace ID 查询的 OS 线程 CPU 证据。EdgeOne 的单次 CPU 证据源、公开清理路径、全流程 `run` 与三个后端的真实账户证据仍未全部完成，因此不能产生 conformance-passed 证据。完整进程接口和完成门槛见 [`provider-adapter-protocol.zh.md`](provider-adapter-protocol.zh.md)。

## 固定边界

1. 每个 adapter 部署同一份 `fixture.mjs` 及其相对模块依赖，不能改写 handler、工作负载或断言。
2. adapter 可以在内部调用固定版本的官方 CLI 或 API，例如 Wrangler、EdgeOne CLI/API 或 Deislet CLI；它只负责打包、部署、调用、读取结构化执行证据和清理。当前锁为 Wrangler 4.129.0、EdgeOne CLI 1.6.32，以及 Deislet source revision `1ddc7b206b4c4ed62f658d79ddd22cfba3599dbb`；锁本身不是 live evidence。
3. adapter 输出符合 `schemas/conformance-observations.schema.json` 的原始观察，不能输出自行判定的 pass/fail。
4. `oracle.mjs` 是唯一结果判定器。运行：

   ```bash
   node conformance/harness/web-fetch-events/oracle.mjs observations.json
   ```

5. `artifactSha256` 必须是 adapter 实际部署的 canonical artifact 摘要；`backend.standardVersion` 必须是 `edge-canon.next@<40 位 source commit>`，不接受浮动的 `next` 或 `latest`。`evidenceRefs` 指向构建、部署、调用或日志原件。
6. adapter 无法读取 failure code、origin hit count 等观察时，该用例失败或保持未执行，不能用供应商错误页文本猜测，也不能省略字段后宣称通过。

canonical artifact 必须用固定构建器从 exact commit 产生，例如：

```bash
node conformance/harness/web-fetch-events/canonical-artifact.mjs \
  --repository "$PWD" \
  --standard-version "edge-canon.next@$(git rev-parse HEAD)" \
  --output /absolute/exclusive/canonical
```

构建器 stdout 返回 manifest 的绝对路径和摘要。把它们填入 adapter request 后，`prepare`
会在 request 的 `workDirectory` 内生成并验证 provider 派生目录；相同输入可安全重入，不同
内容不会被覆盖。

T012 先在 adapter 所在执行机运行 `node conformance/harness/web-fetch-events/calibrate-cpu.mjs`，把输出的 `iterations`、`calibratedCpuMilliseconds` 和 `calibratedWorkSha256` 原样写入 adapter 配置；派生产物会再次核对工作负载摘要。`measuredCpuMilliseconds` 必须来自后端自身的单次 invocation CPU 计量，adapter 还须保存 fresh execution environment 证据，wall time 不可代替。T013 固定为 48 个直接 fetch 加一个发生一次跳转的 fetch，即 49 次 API 调用、50 个计入预算的子请求。T014 的受控 origin 必须在放行响应头前保存已有连接数，不能从最终成功数倒推并发。T015 发送第 `i` 个 octet 为 `i % 251` 的 1,000,000-octet body，固定 SHA-256 为 `2c030d49ec131bfbbb446ad21e7a2f12cdb4f2f4f3fda3ac709dd2e68a4646c7`；请求不得携带 `Content-Encoding`，并必须声明准确的 `Content-Length: 1000000`。

## Harness service

`harness-service.mjs` 把三个测试服务合并到同一地址，令 T013/T014 的服务端事实和 wrapper 发送的生命周期事件可由 `collect` 独立读取。令牌只能经环境变量提供；状态目录必须是本次 operation 独占的绝对路径：

```bash
EDGE_CANON_EVIDENCE_TOKEN='<至少 32 位 URL-safe 随机值>' \
node conformance/harness/web-fetch-events/harness-service.mjs \
  --state-directory /absolute/private/operation-evidence \
  --host 127.0.0.1 \
  --port 0
```

stdout 只输出三个可填入 adapter 配置的 URL。默认只监听回环 HTTP，适合本机测试；边缘平台需要访问时，必须在它前面配置 HTTPS 反向代理并限制网络入口，不能把明文 HTTP 或令牌放到公网。`GET/POST /events` 和全部 `__edge-canon/control` 路径都要求 `Authorization: Bearer <token>`。服务将事件追加到权限为 `0600` 的 NDJSON，逐条 `fsync`，重启时重新验证完整记录；同一 `(backendId, invocationId, eventSequence)` 永不接受第二次写入。一次 operation 不得复用已有事件或已触发的 origin/barrier 状态。

`provider-collection.mjs` 只接受已经完整落盘并绑定部署身份的 invocation。它复核固定请求计划、响应摘要和 96 条预期 wrapper 事件，保存 sink 快照与后端单次 CPU 原件，再生成 15 条 observation。snapshot、CPU 原件、observations 和 collection state 都使用确定性文件名、`0600` 权限与 SHA-256 绑定；崩溃后只会复用逐字节一致的既有文件。collector 不调用 oracle，也不写 `pass`/`compliant`；语义是否通过仍由 canonical `oracle.mjs` 唯一决定。

Cloudflare 派生产物按[官方 Query Builder 要求](https://developers.cloudflare.com/workers/observability/query-builder/)显式启用 Workers Observability、invocation logs 和 100% head sampling。T012 原始 HTTP 证据保存 `cf-ray`；collector 使用 `CLOUDFLARE_ACCOUNT_ID` 与仅经环境传入的 `CLOUDFLARE_API_TOKEN` 调用[官方 Workers Observability Telemetry API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)，以 Ray ID 和本 operation 独占的脚本名过滤，轮询至拿到唯一包含 `$workers.cpuTimeMs` 的 fetch event。若结果缺失、版本冲突或同一条件出现多个 CPU event，collection 失败而不会退化成 wall time。用于真实运行的 token 需要账户级 `Workers Observability Write` 权限。

Deislet runtime 会先清除应用响应写入的整个 `x-deis-*` 命名空间，再以 `x-deis-trace-id` 盖章其日志和 invocation trace 使用的同一 ID；trace 的 `attributes.cpu_time_us` 来自运行线程的 OS CPU 时钟。collector 调用固定 revision 与 SHA-256 的原生 `deis trace --json --trace-id`，凭证只通过 `DEIS_TELEMETRY_AUTH_SECRET` 环境变量进入进程，并复核唯一记录的应用、环境、类型和 HTTP 状态。ID 缺失、记录多于一条、身份不符、CPU 属性缺失或非整数均使证据不可用；`duration_us` 永远不能替代 CPU。配置必须显式给出 `telemetryUrl`，且只能是 HTTPS 或 loopback HTTP。

`sample-pass.json` 只用于 oracle 自测，不是任何后端的运行证据。后续仍必须为三个一等后端各自实现 adapter 并真实运行全部用例，才能把 harness 标为 Complete。
