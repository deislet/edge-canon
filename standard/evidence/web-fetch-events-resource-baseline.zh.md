# Web Fetch Events 最低资源保证证据基线

- 标准：`edge-canon.next`
- 能力族：`web-fetch-events`
- 状态：Evidence Draft；不含规范条款
- 核对日期：2026-09-03
- 参考产品：Cloudflare Workers/Pages、Tencent EdgeOne Makers Edge Functions

本文记录公开、可复核的供应商事实和目前无法求交集的空白，作为 `minimum-resource-guarantees` 的输入。它不把供应商上限直接提升为 Edge Canon 保证，也不产生合规声明。

## 官方来源

- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Pages Functions Pricing](https://developers.cloudflare.com/pages/functions/pricing/)（Pages Functions 请求按 Workers 计量）
- [Tencent EdgeOne Makers Edge Functions](https://pages.edgeone.ai/document/edge-functions)
- [Tencent EdgeOne Edge Functions Overview / Use Limits](https://edgeone.ai/document/53372)
- [Tencent EdgeOne Makers Free Edition Limits](https://edgeone.ai/document/211893332490612736)

EdgeOne Makers 的 Cloud Functions 是区域化 Node/Python/Go 函数产品，不是本能力族当前参考的边缘 JavaScript runtime，不能拿它的 30–120 秒时限填补 Edge Functions 的空白。

## 已公布限制

| 资源 | Cloudflare Workers/Pages | EdgeOne Makers Edge Functions | 当前结论 |
|---|---|---|---|
| 单次 HTTP CPU | Free 10 ms；Paid 默认 30 s、可配置至 5 min | 200 ms，不含 I/O 等待 | 若要求覆盖任意入门套餐，数值交集只能到 10 ms；是否以最低套餐为标准基线尚未决定 |
| 运行内存 | 每 isolate 128 MB；一个 isolate 可并发处理多个请求 | 每执行环境 128 MB；文档称环境隔离 | 数值表面一致，但计量单位、并发归属和超限失败语义尚未一致 |
| 请求 body | Cloudflare Free/Pro 100 MB，其他套餐更高 | 1 MB | 1 MB 可作为候选下限，仍需验证超限前是否进入 handler 及标准错误 |
| 响应 body | HTTP 响应没有强制上限，缓存对象另有限制 | 未公布 | 无法形成正数或无限制保证 |
| HTTP wall time | 客户端保持连接时无硬上限 | 未公布 | 无法形成保证 |
| `waitUntil` 宽限 | 响应完成或客户端断开后最多 30 s | API 存在，但当前材料未公布宽限时长 | 无法形成保证；不能从 API 存在推导时长 |
| 单次子请求 | Free 50；Paid 10,000；同时等待响应头的连接为 6 | 未公布 | 无法形成保证 |
| 函数代码包 | Free 3 MB；Paid 10 MB | 5 MB | 任意入门套餐交集为 3 MB；应最终归入 `canonical-build-artifact` |
| 日志 | 每请求 256 KB | 每次函数最多 20 次 console 调用 | 计量模型不同；应归入 `observability` 并定义统一 drop/error 行为 |
| 语言循环 | 没有同类公开计数限制 | 单函数循环迭代最多 100,000 次 | 属于明显的运行时行为差异，需要真实 fixture 验证编译后计数与失败方式 |

## 尚缺的可发布事实

1. EdgeOne Edge Functions 对响应大小、wall time、`waitUntil`、子请求、并发和超限错误的公开保证。
2. 两家对 CPU 与内存超限时已经开始的响应流、后台任务和同 isolate 其他调用的精确处理。
3. “MB”的精确字节定义、压缩前后计量、chunked body 和提前拒绝位置。
4. 每个限制是否是稳定产品契约、可配置上限、套餐配额或仅防滥用实现细节。
5. Deislet 自建后端可持续提供并可用压力/故障测试证明的下限。

## 必须先作出的产品决策

资源标准无法只靠取最小数字机械完成。必须先决定“参考供应商基线”指所有人都可进入的最低套餐，还是标准版本可以声明每个供应商所需的最低套餐与配置。前者最大化零成本可达性，但会把 HTTP CPU 基线压到 10 ms，并让 SSR 等已接受能力难以给出实用保证；后者可以形成产品级下限，但 provider driver 必须在部署前核验套餐/配置，不满足时按统一错误拒绝。

无论选择哪种基线，标准只公布三个一等后端均能兑现并通过压力与故障 fixture 的下限；更高供应商配额不进入应用可依赖语义。套餐变化只能更新未发布草案或产生新标准版本，不能改写已发布版本。
