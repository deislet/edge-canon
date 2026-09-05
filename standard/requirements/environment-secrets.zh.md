# Environment / Secrets 统一语义（Draft）

- 能力族：`environment-secrets`
- Suite：`EC-ENV`
- 状态：Draft；所有条款仍阻断 `edge-canon.next` 发布
- 行业证据：[`environment-secrets-baseline.zh.md`](../evidence/environment-secrets-baseline.zh.md)
- declaration schema：[`environment-secrets.schema.json`](../../schemas/environment-secrets.schema.json)
- deployment snapshot schema：[`environment-binding-snapshot.schema.json`](../../schemas/environment-binding-snapshot.schema.json)

## 范围

本能力族定义应用如何声明 runtime config/secret、部署如何绑定精确值或 secret revision，以及一次
invocation 能观察什么。它不定义 build-time variables、provider account secret 产品、logical data
resource API 或 provider CLI 的用户界面。

`environment-secrets` 是 EC-WEB `context.env` 值语义的真源。canonical application artifact 只带
declaration；受控 deployment snapshot 和 secret store 在 build 之后绑定。任何 backend 可以使用
原生 variable/secret、provider API 或 companion vault，但应用可观察行为必须相同。

## API

- **EC-ENV-API-001**：canonical artifact 必须包含恰好一个
  `edge-canon.environment-secrets/v1` declaration document；deployment 必须引用一个
  `edge-canon.environment-binding-snapshot/v1`。两者都固定精确 `edge-canon.next@<commit>`，未知字段
  不得由实现自行解释。
- **EC-ENV-API-002**：HTTP 应用从 `context.env.<NAME>` 或等价 bracket access 读取声明的 binding；
  该对象不得暴露 provider 原生 binding/container。启用 EC-NODE 时，`process.env` 只是同一次
  invocation 中 `config + string` 的可写 compatibility projection；JSON、secret、宿主环境和
  provider 系统变量不进入该 projection。
- **EC-ENV-API-003**：v1 支持 `config/string`、`config/json` 与 `secret/string`。config string 和
  secret 的 runtime 值是精确 Unicode string；JSON 先按 RFC 8785 canonical JSON 验证/计量，
  再以对应 JavaScript JSON value 注入。`secret/json` 不属于 v1。
- **EC-ENV-API-004**：每个 declaration 明确 `required`。required binding 必须在 activation 前完整
  解析；未绑定的 optional name 不成为 `context.env` 自有属性。Snapshot 中未声明的 binding
  必须拒绝，不能作为隐式 extension 暴露。
- **EC-ENV-API-005**：每次 invocation 得到新的 null-prototype `context.env`；对象本身和 JSON 的
  所有可达 object/array 都递归冻结。不同 invocation、不同 deployment version 或 provider 原生
  object 之间不得共享可写引用。string 依语言语义不可变。
- **EC-ENV-API-006**：declaration identity 是 declaration document 的 RFC 8785 canonical UTF-8
  SHA-256。Snapshot 必须引用精确 identity，并把每个 config value 或 secret revision 绑定到明确
  `deploymentVersionId` 与 `environmentId`；config revision 必须等于该 string UTF-8 bytes 或 JSON
  canonical bytes 的 SHA-256，secret revision 是 secret store 的不透明不可变 identity；按名称读取同一
  snapshot 必须得到同一 value/revision。

## 错误

- **EC-ENV-ERR-001**：无效 schema/version/name/type、重复 name、超限或 declaration identity
  不匹配必须在 provider derivation/secret resolution 前失败，使用稳定 `EC_ENV_*` code；诊断不含
  value、secret、主机路径、provider credential 或未过滤控制字符。
- **EC-ENV-ERR-002**：required 缺失、未声明 binding、kind/valueType 不符、JSON 非规范/不可表示、
  config revision 不一致或 secret revision 不可用必须在 activation 前失败；不得以 `undefined`、
  空字符串、同名最新 revision 或 provider 默认值代替。
- **EC-ENV-ERR-003**：activation 和 invocation materialization 都是全有或全无。实现不得返回部分
  `context.env`、混用新旧 snapshot、写出成功 selector 后再报告失败，或因某 binding 失败仍执行
  应用 handler。

## 并发、一致性与顺序

- **EC-ENV-CON-001**：一次 invocation 在开始时固定一个已激活 deployment + snapshot identity，
  直至 handler、response stream 与其 EC-STREAM background work 结束；并发 activation 只能观察
  完整 old 或完整 new，不能逐 binding 切换。
- **EC-ENV-CON-002**：相同 declaration、snapshot、secret revision set 和标准版本必须产生相同
  materialized value digests，与主机、进程、请求顺序和 provider account 中的额外 binding 无关。
- **EC-ENV-CON-003**：并发 activate/rollback 使用 expected-current identity 或等价原子比较交换。
  竞争失败不得覆盖获胜版本；重试必须重新读取当前 identity，审计顺序与实际 selector 顺序一致。

## 生命周期

- **EC-ENV-LIFE-001**：build-time input 与 runtime binding 是两个作用域。Runtime config/secret value
  不得成为 source/framework build 输入或 canonical artifact identity；build variable 也不自动进入
  runtime snapshot。
- **EC-ENV-LIFE-002**：新增或修改 config/secret 生成新 immutable binding revision 和新 deployment
  snapshot。已开始 invocation 继续使用旧 snapshot；尚未 activation 的 staging snapshot 不服务
  流量。
- **EC-ENV-LIFE-003**：删除 binding 只影响引用新 snapshot 的 deployment。仍被 active、preview、
  rollback retention 或 in-flight invocation 引用的 secret revision 不得提前销毁；销毁必须经过
  引用检查和审计。
- **EC-ENV-LIFE-004**：rollback 重新激活原 deployment 引用的精确 snapshot 和 secret revisions。
  任一 revision 已不可用时，rollback 在切换前失败并保持当前版本；禁止用同名当前值重建一个
  假冒的旧版本。

## 最低资源保证

- **EC-ENV-LIMIT-001**：一个 deployment snapshot 至少接受 64 个总 binding（config + secret），
  name 在同一 `context.env` namespace 内唯一；第 65 个以稳定 limit error 在派生/上传前失败。
- **EC-ENV-LIMIT-002**：每个 string/secret 的 UTF-8 value 和每个 JSON 的 RFC 8785 canonical UTF-8
  表示至少接受 5120 bytes；5121 bytes 在 secret 写入或 snapshot validation 时失败。计量不含 name、
  JSON 外层协议、加密开销或 provider metadata。

## 安全与隔离

- **EC-ENV-SEC-001**：secret plaintext 不得进入 source、canonical/provider artifact、source map、
  dependency/build cache、identity/cache key、provenance、SBOM、validation report、日志、错误、审计
  payload、CLI argument、进程环境或 conformance observation。
- **EC-ENV-SEC-002**：secret 在 control/store/queue、driver 传输和 provider 配置期间使用项目规定的
  加密与认证通道；plaintext 只在最小权限的写入/materialization 边界短暂存在，失败和取消路径也
  必须清除 staging。不得借用应用 credential 执行管理操作。
- **EC-ENV-SEC-003**：管理 create/update 可接收 secret value，但任何 get/list/status/audit/export
  只能返回 name、kind、revision、状态和时间等 metadata。Runtime 应用按 declaration 权限读取
  plaintext；这不构成管理 readback。
- **EC-ENV-SEC-004**：config、secret 与 logical resource 共用同一个声明 namespace；大小写折叠、
  Unicode normalization 或 provider 重命名后可能碰撞的 name 在 build 时拒绝。不同 tenant/project/
  environment 的 binding 和 vault key 必须物理隔离。
- **EC-ENV-SEC-005**：provider 自动注入的 account、region、deployment、system 或 host variables
  默认排除；只有 Edge Canon declaration 中的 name 可进入 `context.env`。应用不能通过枚举、
  prototype、symbol、错误或 Node façade读取额外 binding。

## 失败与恢复

- **EC-ENV-FAIL-001**：prepare/validation/secret write/materialization/activate 任一步失败都保持当前
  deployment + snapshot 不变，并清除未引用 staging revision；若清理失败，operation 保持可重试
  的非成功状态并记录无 secret 的 cleanup identity。
- **EC-ENV-FAIL-002**：已激活 snapshot 在 invocation 前无法解析完整 revision set 时，backend 必须
  fail closed、不得执行 handler 或回退到旧/新同名值，并产生绑定 deployment/invocation identity
  的受信内部 failure record；对外错误边界由 EC-WEB/对应事件族统一定义。
- **EC-ENV-FAIL-003**：日志、trace、metric、operation 与 conformance evidence 只记录 name 的允许
  metadata、kind、revision 的不可逆标识、snapshot/deployment identity 和稳定 code。故障注入必须
  证明 secret sentinel 在成功、失败、取消、rollback 与 cleanup 输出中的出现次数为零。

## 升级与迁移

- **EC-ENV-UPG-001**：未知 document major、未知字段或浮动 standard version 在读取任何 secret 前
  fail closed。实现可以并存多个已发布 major，但必须按 artifact 固定版本选择 validator/materializer。
- **EC-ENV-UPG-002**：declaration/snapshot 迁移读取 immutable source，生成新的 canonical document
  identity 和显式行为差异记录；不得原地改写已部署 snapshot、secret revision 或历史 audit。
- **EC-ENV-UPG-003**：secret rotation 总是创建新 revision，并经新 snapshot prepare + activation
  生效。旧 revision 在引用/retention 结束后才能销毁；标准/driver 升级不得把 rotation 变成同一
  revision 的不可审计覆盖。

## Draft 完成条件

1. declaration/snapshot schema、reference validator/materializer、fixture、oracle 和三平台 identity
   evidence 全部固定；
2. 与 EC-WEB、EC-NODE、EC-ARTIFACT、EC-DEPLOY、EC-BIND、EC-OBS 和数据生命周期交叉条款一致；
3. Cloudflare、EdgeOne、Deislet 最低档分别通过 63/64/65 与 5119/5120/5121 boundary；
4. 三个一等 backend 完成 create/update/prepare/activate/invoke/rotate/rollback/delete/cleanup；
5. secret sentinel 在 artifact/cache/log/error/audit/argument/evidence 的完整扫描为零；
6. 并发 activation、in-flight invocation、missing revision 与 cleanup failure fault injection 全绿。
