# Web Platform APIs 行业证据基线

- 能力族：`web-platform-apis`
- 记录日期：2026-09-04
- 用途：解释候选条款来源；不具规范效力

## 上游标准与参考产品

本 Draft 逐项选择 [WHATWG Fetch](https://fetch.spec.whatwg.org/)、[WHATWG URL](https://url.spec.whatwg.org/)、[WHATWG Encoding](https://encoding.spec.whatwg.org/) 与 [W3C Web Cryptography Level 2](https://www.w3.org/TR/webcrypto-2/) 的共同可实现语义。参考产品为 [Cloudflare Workers Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)、[Fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/)、[Request](https://developers.cloudflare.com/workers/runtime-apis/request/)、[Response](https://developers.cloudflare.com/workers/runtime-apis/response/)、[Headers](https://developers.cloudflare.com/workers/runtime-apis/headers/) 与 [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)，以及 Tencent EdgeOne 的 [Web standards](https://edgeone.ai/document/52694)、[Fetch](https://edgeone.ai/document/52687)、[Request](https://edgeone.ai/document/52690)、[Response](https://edgeone.ai/document/52691)、[Headers](https://edgeone.ai/document/52689)、[Encoding](https://edgeone.ai/document/zh/52686) 与 [Web Crypto](https://edgeone.ai/document/52693)。

两家都以 V8 为 JavaScript 基础并公开提供 URL、Headers、Request、Response、Fetch、Encoding、Abort、base64、timer 和 Web Crypto。共同存在不等于语义天然相同，因此本 Draft 用可执行向量固定选取的标准行为。

## 已确认差异及标准处理

| 差异 | 官方事实 | Edge Canon 处理 |
|---|---|---|
| URL parser | Cloudflare 旧实现会折叠多斜线并有不同 percent 行为；`URL` 的标准模式从 2022-10-31 起默认启用，而 `Response.redirect()` 的 `response_redirect_url_standard` 从 2023-03-14 起默认启用 | provider packager 必须派生覆盖两者的标准模式；不是应用 profile |
| 跨域 redirect header | Cloudflare 明确警告 `follow` 会把包括 Cookie/Authorization 在内的 header 转发到另一 hostname | 标准采用 Fetch 的 credential stripping；Cloudflare 目标需要 shim 或受控 manual follow |
| Request clone | EdgeOne 文档的 `clone(copyHeaders?)` 含供应商参数且默认可引用原 header | 标准只暴露零参数 clone，两个 Headers 必须独立 |
| body convenience reader | EdgeOne 对 request/response reader 公布 1 MB 上限 | 共同正向下限保守写为 1,000,000 octet；更大输入不作保证 |
| Headers 扩展 | Cloudflare 有 `getAll`/兼容开关下的 `getSetCookie`；EdgeOne 有 `getSetCookie`，且 `forEach` 有非标准提前停止扩展 | 都不进入本 Draft 必需面；标准 callback return value 不改变遍历 |
| Request/Response 扩展 | Cloudflare `cf`/`encodeBody`/`webSocket`，EdgeOne `eo`/`maxFollow`/`version`/`copyHeaders` 等 | 属于 provider 实现细节，不进入应用标准类型 |
| Web Crypto 算法 | 两家算法集合及 MD5 等扩展不同 | 只冻结共同且可确定验证的 random、UUID 与 SHA-256 digest |
| Fetch 平台处理 | EdgeOne 同 Host fetch 可进入边缘 cache/回源，并提供图片处理、timeout 等 `eo` 参数；Cloudflare 有自身 cache/service 行为 | 标准 fetch 不隐含这些平台能力；由未来 cache/service binding 契约显式表达 |

## 共同最低下限

- EdgeOne body convenience reader 的公开 1 MB 限制形成 1,000,000 octet 的保守共同正向下限；Cloudflare 的入站 request body 下限更高，但不能抬高交集。
- EdgeOne Headers 公布 name 255 bytes、value 4,095 bytes；Cloudflare 网络总 header 上限为 128 KB。本 Draft 先只冻结两家都可容纳的 128-character ASCII token name 和 4,095-character printable ASCII value，不从总上限反推 header 数量。
- Web Cryptography 规定 `getRandomValues` 单次 65,536 octet，且两家都公开该 API；该值是标准 API 边界而非套餐配额。
- Fetch 次数/并发和调用 body 下限已经由 `web-fetch-events` 记录，避免在两个 family 重复定义。

## 尚缺的可发布事实

1. EdgeOne 对 URL 总长度、Headers 总字节/数量、Response body 和 timer 调度的稳定最低保证。
2. 两家 FormData multipart parser 的文件、charset、重复字段、容量和错误交集。
3. 三个一等后端对 abort 时机、network error 分类、redirect credential stripping 和 clone/header 独立性的真实证据。
4. Streams family 尚未冻结，因此不能把 body 属性存在误写成完整 backpressure/cancel 保证。
5. Cloudflare/EdgeOne CLI 或 runtime 升级与本标准精确版本之间的兼容锁和回归证据。

## Reference harness 边界

本能力族的 local reference harness 只校验选取语义在 Linux、macOS 与 Windows Node 24+ 的可执行性。它会用本地 HTTP server 检查 redirect 和并发关联，但这不是 Cloudflare、EdgeOne 或 Deislet provider 合规证据，也不替代真实平台对兼容 flag、网络路径和安全 shim 的验证。
