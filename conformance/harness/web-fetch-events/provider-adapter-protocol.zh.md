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

凭证只从 manifest 列出的环境变量传入。凭证值不得出现在 request、argv、artifact、stdout、stderr、result 或 evidence reference 中。子进程仅继承运行所需的最小环境；输出按字节限长，超时终止整个进程树，并在持久化前按全部凭证值脱敏。

EdgeOne CLI 1.6.32 的 `makers deploy` 同时接受 `EDGEONE_PAGES_API_TOKEN` 环境变量和 `--json`，所以 CI adapter 不使用文档示例中的 `-t/--token` 参数。Cloudflare 使用 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 环境变量。Deislet 使用 `DEIS_TOKEN`，控制面 URL 是非秘密配置。

`requiredConfiguration` 按操作分别声明。`inspect` 不读取配置；`prepare` 只读取
`derivedDirectory`、`projectName` 和 `compatibilityDate`；凭证与工具锁只在实际需要它们的
操作读取。这样一次本地产物转换不会因为机器上没有部署凭证而失败，也不会把更大的权限
传给不需要它的进程。

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

## 证据和完成条件

`evidenceDirectory` 必须是本次 operation 独占目录，证据文件使用 `0600`，引用只能指向该目录内的不可变文件或访问受控的远端记录。adapter 输出原始 observation，不增加 `pass`、`compliant` 或 semantic waiver。

manifest 为 `complete` 的必要条件是：八个操作均为 `implemented`、该 suite 全部用例均为 `implemented` 且无 blocker、三个 adapter 都通过真实测试账户运行，并能把 exact standard commit、canonical/derived artifact digest、provider deployment identity 和原始执行证据关联起来。仅完成 inspect/preflight 或本地 mock 仍是 `draft`。
