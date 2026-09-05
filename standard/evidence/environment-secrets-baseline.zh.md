# Environment / Secrets 行业交集与资源基线证据

- 能力族：`environment-secrets`
- 取证日期：2026-09-05
- 状态：Draft evidence；不等于任一 provider 已通过 conformance
- 正式 reference products：Cloudflare Workers、Tencent EdgeOne Edge Functions/Makers
- 补充参考：Deno Deploy（experimental backend，不参与默认交集下限）

## 官方事实

### Cloudflare Workers

- Workers 的 runtime variable 支持 text 与 JSON；handler 通过 `env` 参数取得 binding。
- secret 是加密 text binding，应用仍通过同一个 `env` 对象读取；保存后管理界面和 Wrangler
  不回显 secret value。
- variable/secret 变更以 deploy 生效。Wrangler environment 的 bindings 不继承，必须按环境明确配置。
- Workers Free 当前公开下限为每个 Worker 共 64 个 environment variables、每个 value 5 KB。

官方来源：

- https://developers.cloudflare.com/workers/configuration/environment-variables/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/wrangler/environments/
- https://developers.cloudflare.com/workers/platform/limits/

### Tencent EdgeOne

- Edge Functions environment variable 支持 String、JSON、Secret；JSON 在注入应用前解析。
- 应用从 provider `env` 对象读取；secret 保存后不再显示。
- 新建、修改和删除 binding 后必须 Deploy 才生效。
- 当前公开下限为单个 Edge Function 共 64 个 environment variables 或 secrets、每个 value 最大
  5 KB。
- Pages/Makers 的 build variables 另有 production/preview 作用域和不同限制，只有新 deployment
  才取得改动；它不是 runtime binding。

官方来源：

- https://edgeone.ai/document/62764
- https://pages.edgeone.ai/document/build-guide
- https://pages.edgeone.ai/document/edgeone-cli

### Deno Deploy（补充）

新 Deno Deploy 区分 Production、Development 与 Build contexts，plain text 和 secret 都经
`Deno.env.get` 读取；管理面保存 secret 后不回显。当前公开 value 上限为 16 KiB，key 最大
128 bytes。该 API 和额度用于检验 adapter 设计，但依据 reference-set 决策，不提高也不降低
Cloudflare/EdgeOne 的共同基线。

官方来源：

- https://docs.deno.com/deploy/reference/env_vars_and_contexts/
- https://docs.deno.com/runtime/reference/cli/deploy/

## 语义交集

两家正式参考产品都能稳定表达以下用户可观察能力：

1. runtime configuration string；
2. runtime configuration JSON，在 invocation 可见前解析；
3. runtime secret string，应用可读而管理读取接口不回显 value；
4. binding 属于明确 environment/deployment，修改后通过新的部署状态生效；
5. 同一 runtime 入口取得按名称索引的 environment object；
6. 每个部署至少 64 个 config + secret binding，每个值至少 5 KiB。

Edge Canon 因而采用 `context.env.<NAME>` 作为 provider-neutral 主入口。Provider 原生 `env`
global、Wrangler binding、`Deno.env`、dashboard field 或 CLI flag 都属于 adapter/driver 内部；不能
成为应用针对 target 分支的另一套契约。启用 EC-NODE 时，`process.env` 只能是 EC-ENV string
config 的逐 invocation compatibility projection，不能另取宿主变量，也不承载 JSON 或 secret。

## 规范化选择

- 名称采用可移植安全子集 `[A-Z][A-Z0-9_]{0,63}`。虽然供应商还接受小写或标点，标准不把
  难以一致映射、访问和审计的名称纳入 v1。
- declaration 只记录名称、`config|secret`、`string|json` 与 required；runtime value 不进入
  canonical build output，也不影响 application artifact identity。
- deployment binding snapshot 绑定精确 application declaration identity、deployment version 与
  environment。config value 可以进入受控 snapshot，其 revision 是 canonical value bytes 的 SHA-256；
  secret 只记录不可变的不透明 revision，plaintext 由受保护 secret store 在 provider prepare/runtime
  materialization 边界解析。
- config JSON 使用 RFC 8785 canonical JSON 计量和持久化；每次 invocation 得到递归 clone/freeze
  的值，不能跨 invocation 写入共享对象。
- required binding 缺失、类型不符、额外 binding 或 secret revision 不可用都在 activation 前
  fail closed。切换是完整 snapshot 原子切换，运行中的一次 invocation 不观察混合版本。
- 回滚只可重新绑定原 deployment 引用的精确 config/secret revisions；revision 已销毁时回滚失败
  且保持当前版本，不得悄悄使用同名最新 secret。
- secret plaintext 不进入 artifact、source map、cache key、日志、错误、审计 payload、命令行参数
  或 conformance observation。管理读取只返回 name/kind/revision/status 等 metadata。

## 最低资源保证

Draft 候选固定为：

- `config + secret <= 64`，计数作用域是一个 deployment version 的 runtime binding snapshot；
- 单个 string/secret 使用 UTF-8 bytes 计量，`<= 5120`；
- JSON 使用 RFC 8785 canonical UTF-8 bytes 计量，`<= 5120`；
- 名称在 config、secret 与 logical resource 的同一 `context.env` namespace 内唯一。

5 KB 是否在 EdgeOne 控制面严格按 5120 bytes 执行、边界失败代码、并发 Deploy 的冲突行为，
仍须用最低档真实账户在 5119/5120/5121 bytes 与 63/64/65 bindings 上验证。在这些 provider
evidence 完成前，本能力族保持 Draft；文档存在不能代替边界 conformance。

## 排除项与待证事项

- build-time variables 不属于 EC-ENV runtime snapshot；它们以后由 canonical build input/provenance
  规则定义，禁止自动透传到 runtime。
- provider account/global secret store、secret rotation scheduler 和外部 vault 产品不是 v1 应用 API；
  driver 可以在内部使用，但必须交付同一 revision/rollback 语义。
- provider 额外注入的 account、region、deployment 或系统变量不进入 `context.env`，除非未来标准
  以新名称和语义明确接纳。
- 仍缺 Cloudflare、EdgeOne、Deislet 三条真实 prepare/activate/invoke/rollback/delete evidence，
  包括 secret sentinel 扫描、并发 invocation、失败保持旧版本和销毁 revision 后回滚拒绝。
