# Deployment / Preview / Rollback 统一语义（Draft）

- 能力族：`deployment-preview-rollback`
- Suite：`EC-DEPLOY`
- 状态：Draft；所有条款仍阻断 `edge-canon.next` 发布
- 行业证据：[`deployment-preview-rollback-baseline.zh.md`](../evidence/deployment-preview-rollback-baseline.zh.md)
- immutable plan schema：[`deployment-plan.schema.json`](../../schemas/deployment-plan.schema.json)
- observed status schema：[`deployment-status.schema.json`](../../schemas/deployment-status.schema.json)

## 范围

本能力族定义 immutable application version 如何经过 `prepare → verify → activate` 成为 production
deployment，怎样提供 version preview、严格全量与两版本渐进发布，以及 pause、abort 和 rollback 的共同
语义。它不规定某家 provider 的 CLI/UI，也不把 provider 的传播延迟伪装成全局物理同时切换。

`DeploymentPlan` 是 immutable desired revision；`DeploymentStatus` 是对该 plan 的可变 observed record。
两者分离，使写入控制面 selector 不会自动得到 `active` 结论。Backend 可以调用原生 deployment API，
也可以提供受标准约束的 routing layer，但应用和 operator 观察到的状态、版本选择与失败语义必须相同。

## API

- **EC-DEPLOY-API-001**：artifact/provider version 是不可变代码、assets、标准版本、binding declaration
  与 manifest identity；上传 version 不改变 production traffic。Deployment 是独立 immutable plan
  revision，任何流量、binding snapshot 或回滚变化都创建新 deployment identity。
- **EC-DEPLOY-API-002**：每个 plan 使用 `edge-canon.deployment-plan/v1`，绑定精确 standard version、
  environment、至多一个 baseline 和一个 candidate、各自 version/artifact/snapshot identity、整数
  basis-point weight、routing generation、affinity/override、expected-current 与 activation policy。
- **EC-DEPLOY-API-003**：每个 plan 的状态使用 `edge-canon.deployment-status/v1`，引用 plan SHA-256，
  同时返回 desired state、observed routing generation、逐 target/proxy observation、gate evaluation、
  failure code 和时间。`active` 只在 desired/observed 满足 plan 保证后成立。
- **EC-DEPLOY-API-004**：标准状态机至少表达 `created → preparing → prepared → verifying → ready →
  activating → active`，以及 `failed`、`degraded`、`reconciling`、`paused`、`progressing`、`aborting`
  和 `rolled-back`。状态改变使用 expected-current state/revision 或等价 CAS。
- **EC-DEPLOY-API-005**：每个 immutable version 有不影响 production weight 的 preview URL。显式 QA
  override 只能选择当前 deployment 中的版本（包括 0% candidate），并使用短期、签名、绑定
  application/environment/deployment/version/audience 的 token；普通请求 header 不能直接指定 version。
- **EC-DEPLOY-API-006**：渐进 plan 明确 step index、候选 basis-point weight、soak duration、manual/
  automatic gate 和 affinity generation；pause 保持当前权重，resume 重验 gate，abort 把 candidate 新流量
  降为 0，完成后 candidate 成为 10000 basis points 的单版本 deployment。
- **EC-DEPLOY-API-007**：rollback 创建新的 deployment revision，引用历史 version 的精确 binding
  snapshot；它不原地改写历史 deployment，也不回滚 KV/SQL/blob/queue 数据。普通 rollback 必须先验证
  当前 resource/schema 与旧代码兼容；emergency mode 只可跳过非必要 gate并完整审计。

## 错误

- **EC-DEPLOY-ERR-001**：无效 schema/standard pin、重复 role、超过两个版本、weight 非整数/越界/和不为
  10000、identity 或 plan digest 不匹配，必须在 provider upload/prepare 前以稳定 `EC_DEPLOY_*` code
  拒绝，不得自动归一化比例或猜测 baseline。
- **EC-DEPLOY-ERR-002**：未准备/未验证 target、binding/resource incompatibility、smoke failure、缺少
  gate 数据或未确认 routing generation 时不得 activate；旧 active deployment 与 production selector 保持
  不变，status 明确 failure/paused/reconciling，而不是返回成功。
- **EC-DEPLOY-ERR-003**：过期、伪造、scope 不匹配或不属于当前 deployment 的 override 必须拒绝或按正常
  affinity/weight 路由，并记录不含 token/subject 的稳定原因；绝不能让外部用户任意选择历史 version。
- **EC-DEPLOY-ERR-004**：普通 rollback 若历史 snapshot/revision/resource 不可用或 data schema 不兼容，
  必须在 production selector 改变前失败；禁止用当前同名 binding 重建旧 snapshot，或声称 application data
  已随代码回滚。

## 并发、一致性与顺序

- **EC-DEPLOY-CON-001**：默认 `atomic` policy 要求配置的全部 serving target 完成 prepare/readiness；任一
  target 失败时 candidate 不得获得 production traffic，旧 deployment 在所有可服务路径上保持 active。
- **EC-DEPLOY-CON-002**：candidate 必须先在 target 上成为按 generation 可寻址但不接受普通 production
  selector 的 routable version；routing generation 提交后，edge/proxy 只把该 generation 交给已确认
  routable 的 target。不得在节点逐一 swap 时让普通请求随机命中新旧 generation。
- **EC-DEPLOY-CON-003**：一次 invocation、HTML/asset/API 同源请求链、response stream、WebSocket 和
  background work 在开始时固定 deployment/version；已开始工作不因权重变化、pause、abort 或 rollback
  中途迁移。内容摘要资产可按相同内容 identity 安全复用。
- **EC-DEPLOY-CON-004**：默认 rollout-scoped stable affinity 使用平台信任的 subject 或签名匿名 cookie，
  对 `(deployment generation, subject, salt)` 做确定性选择。客户端不能伪造 version；默认已分配用户在
  rollout 内保持版本，新用户按当前权重选择。
- **EC-DEPLOY-CON-005**：并发 activate/step/abort/rollback 以 expected-current deployment/state CAS；
  最多一个变更推进 selector。审计 sequence、routing generation 和 operator 可见历史必须与真实提交
  顺序一致，失败重试先重新读取 observed state。

## 生命周期

- **EC-DEPLOY-LIFE-001**：prepare 下载/上传并验证 artifact digest，创建 staged isolate/provider version，
  解析 routes/bindings/triggers/secret revisions 并执行 readiness；这些资源在 verify/activate 前不接收普通
  production traffic。
- **EC-DEPLOY-LIFE-002**：verify 通过 immutable version preview 或 0% scoped override 执行标准 smoke、
  用户检查和 dependency preflight；结果绑定 deployment/version/artifact/snapshot/target identity。
- **EC-DEPLOY-LIFE-003**：activate 先使 candidate 在所有选定 serving target 可按 routing generation 寻址，
  再提交 production routing generation，最后观察 edge/provider 与 target ack。仅 DB pointer 写入不构成 active。
- **EC-DEPLOY-LIFE-004**：渐进 step 每次创建或推进明确 revision，保存输入 metrics、阈值、样本窗口、
  soak 起止与决定原因。数据缺失默认 pause，不能视为健康；automatic advance 不允许丢失计算证据。
- **EC-DEPLOY-LIFE-005**：旧版本停止接收新 invocation 后进入 draining；已有 stream/WebSocket/background
  work 按 policy 完成。Queue consumer 先停止旧 lease acquisition 再 drain in-flight；一个 cron tick 和一条
  queue message 不因 rollout 被计划外双投递。
- **EC-DEPLOY-LIFE-006**：abort/rollback/完成后 affinity 与 override 在其 scope/TTL 结束时失效；旧 version、
  snapshot 和 staging resource 只在 rollback/drain/preview retention 结束且引用为零后清理，清理结果可重试。

## 最低资源保证

- **EC-DEPLOY-LIMIT-001**：一个 active deployment 至多包含两个 version；weight 使用整数 basis points，
  每项在 0..10000 且总和恰为 10000。1 basis point（0.01%）必须可表达；第三个 active version 在 provider
  mutation 前拒绝。
- **EC-DEPLOY-LIMIT-002**：每个 environment 至少保留最近 3 个成功 immutable version 的 metadata、
  artifact/snapshot 引用与可预览或可重新部署能力；resource 已删除导致不可运行时必须显式报告，不能把
  metadata retention 冒充 rollback 可用。
- **EC-DEPLOY-LIMIT-003**：atomic 模式不得以 quorum、best effort 或“当前可达 target 全部成功”代替
  configured serving set；若 operator 选择不同 capacity/fault-domain policy，它必须成为显式 plan 字段且
  不降低标准对应用声明的保证。

## 安全与隔离

- **EC-DEPLOY-SEC-001**：preview URL 是不可变 version scope，不授予管理权；private application 的 preview
  继承访问控制。Preview/override request 在 log/trace 中标记，但 token、签名 secret 和敏感 subject 不记录。
- **EC-DEPLOY-SEC-002**：routing generation、version override、affinity cookie 与 service-binding propagation
  由可信 edge/driver 签名或在受认证内部通道产生；所有外部同名 header/cookie 先移除再写入可信值。
- **EC-DEPLOY-SEC-003**：管理 mutation 使用独立管理 credential 和 actor audit；应用 runtime credential、
  preview token 与普通 traffic identity 不得调用 prepare/activate/rollback 或改变 weight。
- **EC-DEPLOY-SEC-004**：service binding 传播 caller deployment/version/affinity context，并在 activation
  preflight 验证 callee contract/version 范围；无兼容 callee 时阻止 activation，不随机落到不兼容版本。

## 失败与恢复

- **EC-DEPLOY-FAIL-001**：prepare/verify 失败保持旧 active，不写 production generation；本次新建且无引用
  staging 进入补偿清理。清理失败保留可重试 operation/resource identity，而不是把 deployment 标成成功。
- **EC-DEPLOY-FAIL-002**：routing generation 已提交但 observation 未齐时状态是 `activating`、`degraded` 或
  `reconciling`，绝不是 `active`；普通请求只能到与 desired generation 一致的 routable target，不能静默回退
  到旧 generation。
- **EC-DEPLOY-FAIL-003**：控制面/driver 重启从 durable plan、transition journal、provider operation identity
  与 target/proxy observations 恢复；相同 idempotency key 不得创建第二次 provider mutation 或跳过状态。
- **EC-DEPLOY-FAIL-004**：provider timeout/断连后的未知结果必须先 inspect/reconcile；不得把 timeout 当失败
  后盲重放非幂等 activate，也不得把未观察到错误当成功。无法确定时保持 `reconciling` 并阻止冲突 mutation。
- **EC-DEPLOY-FAIL-005**：activation 后的健康退化按 plan 执行 pause/abort/rollback；自动决定保存输入证据。
  Emergency rollback 可以优先恢复安全，但目标 artifact、必要 binding 与 routing authority 仍须验证。

## 升级与迁移

- **EC-DEPLOY-UPG-001**：未知 plan/status major、未知字段或浮动 standard version 在 upload/prepare/secret
  resolution 前 fail closed。已发布 major 可并存，但每个 plan 按自己固定的 validator/driver 运行。
- **EC-DEPLOY-UPG-002**：plan/status schema 或 provider mapping 升级从 immutable source 生成新 plan identity
  和行为差异记录；不得原地改写 active/历史 plan、observations、gate evidence 或 audit sequence。
- **EC-DEPLOY-UPG-003**：driver/platform 升级期间保留 generation fencing 和双读迁移；只有新旧控制面、edge、
  target 对同一 desired/observed identity 达成一致后才切换 writer。旧 token/capability 在引用清零后撤销。

## Draft 完成条件

1. plan/status schema、reference state machine、fixture、oracle 和三平台 identity evidence 固定；
2. 与 EC-ARTIFACT、EC-ROUTING、EC-ENV、EC-STREAM、EC-ASYNC、EC-BIND、EC-STATE、EC-OBS 一致；
3. Cloudflare、EdgeOne、Deislet 真实账户完成 upload/prepare/preview/activate/observe/abort/rollback/cleanup；
4. atomic 部分失败、proxy ack 丢失、provider timeout、重启恢复与 CAS fault injection 全绿；
5. 0/1/9999/10000 basis points、第三 version、3-version retention 与稳定 affinity 边界全绿；
6. stream/WebSocket、queue/cron、service binding 和 binding/data rollback 交叉用例全绿。
