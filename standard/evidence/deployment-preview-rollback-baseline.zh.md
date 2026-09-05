# Deployment / Preview / Rollback 行业基线（2026-09-05）

本记录只说明 Draft 候选语义的来源，不是 provider conformance evidence。Reference set 仍按治理决定为
Cloudflare Workers/Pages 与 Tencent EdgeOne Makers；Deislet 是参考实现，不参与“主流功能交集”投票。

## Cloudflare Workers

- 官方 Gradual Deployments 文档（取证 2026-09-05）：version upload 不自动部署；deployment 可以在两个
  version 间按百分比分流，支持逐步提高至 100%、observability、rollback、version affinity 与 version
  override。文档同时明确默认每个请求独立分配会产生 version skew。
  <https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/>
- 官方 Version Overrides 文档（取证 2026-09-05）：override 只能选择当前 deployment 中的 version，包含
  0% version；当前最多两个 version，并可经 service binding 传播。Edge Canon 不直接照搬其可由外部传入的
  header，而采用签名、短期、scope-restricted token，避免普通客户端成为版本路由 authority。
  <https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/>
- 官方 Rollbacks 文档（取证 2026-09-05）：rollback 创建新的 active deployment；split deployment 回滚为
  单版本 100%；资源和 application data 不随代码回滚，binding/resource 或 Durable Object migration 不兼容
  会阻止回滚；可选最近 100 个发布版本。
  <https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/>

## Tencent EdgeOne Makers

- 官方 Deployment Overview（取证 2026-09-05）：每次新 deployment 获得唯一 preview URL；成功记录超过
  三个后只保留最近三个 artifact 可访问，expired deployment 返回 401，但可用相同配置 redeploy。官方页面
  当前没有公开等价的两版本 traffic split、stable affinity 或非交互 status/cleanup 契约。
  <https://pages.edgeone.ai/document/deployment-overview>

## 共同语义与补齐边界

两者共同支持 immutable deployment/version history、成功后独立 preview、production promotion/redeploy 和
历史回退；最低公开 retention 交集为最近 3 个成功 version。Cloudflare 的两版本 gradual/affinity/override
是主流领先语义，但 EdgeOne 当前没有公开等价 primitive。按统一标准原则，EdgeOne driver 必须通过受控的
front routing layer 补齐，不能把该后端降为另一套应用 profile。

`prepare → verify → activate → observed active` 是 Edge Canon 为解决 provider propagation、自建多节点和
真实状态报告而增加的 provider-neutral 生命周期。它不宣称 Cloudflare 或 EdgeOne 使用同名内部步骤；driver
必须把原生 operation/preview/deployment status 映射为相同可观察保证，并在无法证明时保持 Draft/阻断状态。

HTTP、queue、cron 的严格 activation barrier 是上述生命周期在多 trigger 应用上的一致性补全，不是对任一
provider 内部 API 或 RPC 的照抄。既然标准允许同一 immutable version 同时声明这三类入口，production
selector、binding snapshot、queue admission 与 cron dispatch 就不能各自成为互不相关的“当前版本”。因此
标准以完整 candidate/previous owner、持久 observation 和 CAS 定义可观察顺序；provider 可使用原生 deployment
primitive、受控 routing layer 或两者组合实现，但不得暴露较弱的应用语义。
