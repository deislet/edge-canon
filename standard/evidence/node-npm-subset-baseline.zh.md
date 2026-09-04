# Node/npm 版本化子集行业证据基线

- 核对日期：2026-09-04
- 语义真源：Node.js 24.20.0 官方文档与上游 tests
- 参考供应商：Cloudflare Workers/Pages、Tencent EdgeOne/EdgeOne Makers
- 政策：统一标准定义应用面；provider 可选择原生、shim 或不同部署执行器，但不能产生应用 profile。

## 行业事实

| 主题 | Node.js / Cloudflare | Tencent EdgeOne / Deno | Edge Canon 结论 |
| --- | --- | --- | --- |
| Node 基线 | [Node.js 24.20.0 文档](https://nodejs.org/download/release/latest-v24.x/docs/api/) 是当前 v24 LTS 语义版本；[Cloudflare Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) 声明大量 Node API 原生支持 | [Deno Node/npm compatibility](https://docs.deno.com/runtime/fundamentals/node/) 支持几乎全部 `node:` module、package.json、CommonJS 与 npm | 以 Node 24.20.0 为真源，供应商实现只作可行性和差异证据 |
| Cloudflare stub | Cloudflare 明确区分 native、partial、import-only stub；unenv mocked method 可能 noop 或调用时抛错 | EdgeOne Node Functions 运行真实 Node；Deno 明确披露部分 API 和 native addon 差异 | stub/noop 不算支持；清单外符号必须预部署失败 |
| EdgeOne 执行器 | Workers 可在 isolate 中实现 Node subset，同时保留 Fetch handler | [EdgeOne Node Functions](https://pages.edgeone.ai/document/node-functions) 公开 `node:crypto`、完整 npm 生态和 Fetch-style handler；[Build Output](https://pages.edgeone.ai/document/building-output-configuration) 将 Node API 输出到 `cloud-functions/api-node/` 并携带 `node_modules` | EdgeOne adapter 可透明选择 Node Function；应用仍使用同一标准入口 |
| npm 与 CommonJS | Node 官方 package 文档定义 package.json、exports/imports、ESM/CommonJS；Cloudflare bundler 处理 npm 与 polyfill | Deno 支持 package.json、bare import、CommonJS、npm cache/node_modules | npm 是构建能力，最终 artifact 统一为静态 ESM graph |
| process/宿主 | Node 原生 process 暴露主机；serverless provider 的 process 实现和版本会漂移 | EdgeOne 示例读取 process.version/pid，Deno 报告兼容 Node 版本而非宿主 Node | 只提供锁定、规范化的受限 process；禁止宿主拓扑成为标准输入 |

## 首版 export 选择

首版包含 assertion、异步上下文、Buffer、常用 crypto、diagnostics channel、events、纯路径处理、受限 process、querystring、Node streams、StringDecoder、timers、URL/util 与同步压缩。它们同时满足三项条件：主流 server/framework package 高频使用；Cloudflare 明确列为 native supported；EdgeOne Node Functions 和 Deno 有真实实现路径。

`node:stream/web` 暂不纳入，因为现有 Streams Draft 明确不保证应用直接构造 Readable/Writable stream；`fs`、`http/https`、`dns/net/tls`、`module` 与 `os` 需要分别解决 bundle filesystem、监听/客户端、网络策略、动态解析与宿主身份，不能只因供应商有同名 module 就提前纳入。`child_process`、cluster、worker threads、native addon 与 FFI 不适合当前统一 serverless sandbox。

## npm 供应链基线

package-lock v3 是首版唯一规范 lock 输入。registry dependency 必须锁定 resolved source 和 sha512 integrity；认证只在 build fetch 期间存在。依赖安装 hook、native `.node`、git dependency、动态未枚举 require/import 与 runtime install 都是确定性、安全和多后端复现的阻断项。CommonJS 是 source compatibility，必须在构建阶段变成 ESM，不能要求边缘 runtime 提供宿主 `require` 或 node_modules 查找。

16 package、1,048,576 octet 是 Draft conformance 正向候选，不代表最终产品上限。Cloudflare 与 EdgeOne 的公开 package/artifact 限制口径不同，必须在同一 canonical artifact 上真实测量后才能冻结更高下限。

## 发布阻断项

1. 三个一等后端逐 export 运行 Node upstream-derived tests；
2. EdgeOne adapter 生成 `cloud-functions/api-node`，并验证路由、bindings、streaming、错误与 rollback 与 Edge Functions 输出一致；
3. Deislet runtime 增加 Node compatibility layer，或透明 companion runtime，且保持同一 Fetch/Context/tenant isolation；
4. build resolver 实现 package-lock v3、registry auth、integrity、conditional exports/imports、CJS transform 与内容寻址缓存；
5. 将 Cloudflare partial/stub 与 Deno/Node version drift 纳入持续差异探测；
6. 资源、secret、cache poisoning、archive escape 和 package manager failure 全部取得故障注入证据。
