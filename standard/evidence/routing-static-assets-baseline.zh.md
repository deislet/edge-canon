# Routing 与 Static Assets 行业证据基线

- 能力族：`routing-static-assets`
- 记录日期：2026-09-04
- 用途：解释候选条款来源；不具规范效力

## 共同能力

Cloudflare Workers Static Assets 与 Tencent EdgeOne Makers 都能把静态文件和函数作为同一部署单元，默认在 URL 命中静态文件时直接返回文件；未命中时再进入函数或显式 fallback。两者都提供路径 redirect、rewrite、SPA fallback 和按路径附加响应 header，也都允许框架构建输出表达有序 routing 配置。

标准只取可在两家实现的确定性交集：

1. 匹配输入是 URL pathname，不含 query，区分大小写；
2. source pattern 只含 literal segment、完整 `:name` segment 和最多一个位于末尾的 `*`；不把供应商 regex、cookie/header/region 条件纳入本 Draft；
3. redirect 先于 rewrite，rewrite 最多执行一次；完成路径变换后，静态资源优先于函数；
4. redirect 只冻结 301/302，内部 path 或字面量 HTTPS authority 加 path template，以及显式 query preserve/discard；
5. header rule 只作用于静态资源与静态 fallback，避免把 Cloudflare `_headers` 不作用于 Functions 的行为误扩成函数保证；
6. SPA 和 custom 404 都必须显式声明，不继承供应商自动检测默认值。

## 共同最低下限

- Cloudflare Pages `_redirects` 公布最多 2,000 条静态、100 条动态 redirect/proxy 规则；EdgeOne `edgeone.json` 公布 redirect 最多 100、rewrite 最多 100。为避免把 Cloudflare 的 redirect/proxy 共享动态池误算成两个独立池，本 Draft 只承诺至少 100 条 redirect+rewrite 合计规则。
- Cloudflare Pages `_headers` 公布最多 100 个 header rule；EdgeOne `edgeone.json` 公布最多 30 个，因此共同下限为 30 个 header rule。
- 两家未给出可直接对齐的最小单文件大小、总静态容量或 asset 数量保证；这些仍阻断本能力族进入 normative-complete。

## 明确不取的供应商差异

- Cloudflare Pages 的 extensionless HTML、最近层级 `404.html`、SPA 自动推断、ETag/304 和压缩默认值不自动成为标准。
- EdgeOne 的 RE2 route、`has`/`missing` 条件、默认 hash-file cache 策略和供应商缓存失效周期不自动成为标准。
- `Range`/206、自动内容协商、弱/强 ETag、边缘 cache TTL，以及 GET/HEAD 以外请求方法命中静态文件时的差异尚未有足够共同证据，本 Draft 不作保证。

## 官方资料

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Workers Static Assets routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [Cloudflare Workers Static Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Cloudflare Pages redirects](https://developers.cloudflare.com/pages/configuration/redirects/)
- [Cloudflare Pages headers](https://developers.cloudflare.com/pages/configuration/headers/)
- [Cloudflare Pages serving behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/)
- [Tencent EdgeOne Makers Edge Functions routing](https://pages.edgeone.ai/document/edge-functions)
- [Tencent EdgeOne edgeone.json](https://pages.edgeone.ai/document/edgeone-json)
- [Tencent EdgeOne Build Output Configuration](https://pages.edgeone.ai/document/building-output-configuration)
- [Tencent EdgeOne custom 404](https://pages.edgeone.ai/document/custom-404-page)
