# Routing 与 Static Assets 候选要求

- 标准：`edge-canon.next`
- 能力族：`routing-static-assets`
- 状态：Draft Candidate
- 规范效力：无；仅在 Proposal 0001 晋级并发布后生效
- 最后核对参考实现：2026-09-04

本草案定义 canonical Build Output 中 `routes` 语义文档的第一版。文档必须符合 [`routing-static-assets.schema.json`](../../schemas/routing-static-assets.schema.json)，并由 canonical manifest 的 `documents` 条目和文件摘要绑定。供应商的 `_redirects`、`_headers`、Wrangler assets、`edgeone.json` 或 Build Output routes 都是 provider packager 的派生目标，不是应用可选 profile。

## 1. API

- **EC-ROUTING-API-001**：一次路由解析必须按固定管线执行：按声明顺序选择首个 redirect；没有 redirect 时按声明顺序选择首个 rewrite 且最多改写一次；随后仅对 GET/HEAD 以改写后的 pathname 先查静态资源，再按声明顺序查函数路由，最后执行显式 fallback。任一终态后不得继续进入下一阶段。
- **EC-ROUTING-API-002**：source pattern 对已经通过安全规范化的 URL pathname 进行区分大小写匹配，query 不参与匹配。pattern 可含 literal segment、完整的 `:name` 单段参数和最多一个位于末段的 `*`；参数与 splat 可在 destination 中按原始编码后的安全 segment 值替换。
- **EC-ROUTING-API-003**：静态资源必须由 `assets` 显式把唯一 URL pathname 映射到 canonical output 中一个普通文件，并绑定 size、SHA-256 与 media type。identity 请求下返回的 body octet 和声明文件相同；HEAD 的 header 语义与 GET 相同且不返回 body。Range、自动压缩和 ETag 不在本 Draft 保证内。
- **EC-ROUTING-API-004**：redirect 必须返回 301 或 302，设置由内部 path template，或字面量 HTTPS authority 加 path template 生成的 `Location`，并显式声明保留或丢弃原 query。redirect 不读取响应文件、不执行 rewrite、函数或 fallback。
- **EC-ROUTING-API-005**：rewrite 只改变本次解析使用的 pathname 和显式 query policy，不改变 HTTP method/body，不向客户端暴露中间路径，也不再次执行 redirect 或 rewrite；目标随后进入 asset-first 解析。
- **EC-ROUTING-API-006**：header rule 按声明顺序选择首个匹配项，只可作用于静态 asset、custom-404 或 SPA 响应。header name/value 必须是 schema 允许的 ASCII，且不得设置 hop-by-hop、`Content-Length`、`Location`、`Set-Cookie` 或供应商保留 header；函数响应自行负责 header。

## 2. 错误

- **EC-ROUTING-ERR-001**：route 文档字段、pattern、参数引用、重复 ID/asset URL/header name、目标文件或摘要无效时，构建必须在 provider 派生前失败，并返回稳定 `EC_ROUTING_*` 代码；错误不得含 secret、主机绝对路径或未转义请求数据。
- **EC-ROUTING-ERR-002**：没有 redirect/rewrite/asset/function 命中时，`not-found` 返回固定 404 空 body；`custom-404` 返回声明文件、声明 media type 和 404；`spa` 返回声明文件、声明 media type 和 200。fallback 不回源、不猜测最近 404 文件，也不因 User-Agent 或导航 header 改变。

## 3. 并发、一致性与顺序

- **EC-ROUTING-CON-001**：redirect、rewrite、header 与 function 数组顺序属于语义；同一阶段只使用首个匹配规则。asset URL 必须唯一，且在 asset 与 function 同时命中时 asset 总是获胜，不得按供应商、缓存状态、上传顺序或节点改变优先级。
- **EC-ROUTING-CON-002**：同一不可变 route 文档、asset 文件集合、标准版本和规范化 Request 必须产生同一终态、参数、status、Location、header 与 body digest；cache hit/miss、压缩选择和边缘位置不得改变这些标准观察值。

## 4. 生命周期

- **EC-ROUTING-LIFE-001**：route 文档与其 asset 集合必须随一个 canonical artifact version 原子激活和撤回；请求只能观察旧集合或新集合，不能观察新路由配旧文件、旧路由配新文件或部分 header rule。跨部署 alias 切换由 `deployment-preview-rollback` 进一步定义。

## 5. 最低资源保证

- **EC-ROUTING-LIMIT-001**：一个 canonical route 文档必须支持至少 100 条 `redirects` 与 `rewrites` 合计规则，每条 source/destination 最长 500 个 ASCII 字符；这是共同最低值，不代表第 101 条可移植。
- **EC-ROUTING-LIMIT-002**：一个 canonical route 文档必须支持至少 30 条 header rule，每条最多 30 个 name/value；header name 最长 100 个 ASCII 字符，value 最长 1,000 个 ASCII 字符。静态文件数、单文件和总 artifact 大小仍未冻结。

## 6. 安全与隔离

- **EC-ROUTING-SEC-001**：进入匹配器前必须验证 percent escape、拒绝 NUL、反斜杠、空 segment（包括重复或尾随 `/`）、编码后的 `/` 或 `\\`、以及解码后出现的 `.`/`..` segment；失败返回固定 400 且不执行任何规则。规范化只执行一次，不能由 provider 再次解码产生另一目标。
- **EC-ROUTING-SEC-002**：外部 redirect 只允许清单中的字面量 HTTPS authority，不能从请求 Host、header、cookie、query 或 path 参数构造 authority。header value 不得包含 CR/LF，禁止字段不得由大小写变体绕过。
- **EC-ROUTING-SEC-003**：asset filePath 必须满足 canonical output portable path 规则并指向已列普通文件；`..`、绝对路径、symlink/junction/hardlink alias 和未列文件都必须在构建期拒绝，运行时不得访问 canonical output 之外的文件系统。

## 7. 失败与恢复

- **EC-ROUTING-FAIL-001**：任何 route 文档、asset 索引或文件验证失败都不得产生 provider derived artifact；缓存中的 route/asset 必须在使用前重新验证其 parent canonical identity，不能自动删规则或退回供应商默认路由。
- **EC-ROUTING-FAIL-002**：rewrite 目标未命中后只能进入本 document 的显式 fallback；不得链式 rewrite、隐式回源、执行供应商默认页面或把失败请求交给另一个部署。一次请求最多执行一个函数入口。

## 8. 升级与迁移

- **EC-ROUTING-UPG-001**：实现只接受明确支持的 `edge-canon.routing-static-assets` major 和 route 文档内的精确标准 commit；未知 major、浮动版本或未知字段必须在读取 asset body 前拒绝。
- **EC-ROUTING-UPG-002**：已发布标准版本中的匹配、优先级、fallback 和 header 语义不可原地改变。迁移器以旧文档为只读输入生成新 canonical artifact identity，并用同一用例集比较每个 route 的旧/新终态；有意改变必须作为显式应用升级。

## 9. 晋级条件

进入 `normative-complete` 前仍需：

1. 冻结静态文件数、单文件/总大小、GET/HEAD 以外请求方法、Range/conditional request 和内容编码共同保证；
2. 与 `web-platform-apis` 固定 URL/path percent-normalization 的上游算法版本；
3. 把 routes 文档加入 canonical artifact reference fixture，并由三个 provider packager 派生真实配置；
4. 在 Cloudflare、EdgeOne、Deislet 上运行相同 redirect/rewrite/asset/function/fallback/header oracle；
5. 对真实部署做原子版本切换、缓存陈旧、路径混淆和 header injection 故障测试。
