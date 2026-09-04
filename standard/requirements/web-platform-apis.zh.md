# Web Platform APIs 候选要求

- 标准：`edge-canon.next`
- 能力族：`web-platform-apis`
- 状态：Draft Candidate
- 规范效力：无；仅在 Proposal 0001 晋级并发布后生效
- 最后核对参考实现：2026-09-04

本草案固定边缘应用直接使用的 Web API 共同子集。应用面对一个标准，不面对 Cloudflare、EdgeOne 或 Deislet profile；后端打包器必须用供应商兼容日期、生成代码或运行时适配实现同一语义。完整的必需面记录在 [`web-platform-apis.schema.json`](../../schemas/web-platform-apis.schema.json) 所约束的 capability lock 中。

本草案只引用并逐条选取 WHATWG Fetch、URL、Encoding 和 W3C Web Cryptography 语义。上游是 living standard 不表示其未来变化自动进入已发布的 Edge Canon 版本；应用锁定的 Edge Canon commit 才是可部署契约。

## 1. API

- **EC-WEBAPI-API-001**：`URL` 与 `URLSearchParams` 必须服从锁定版本选取的 WHATWG URL 解析、序列化、相对解析、默认端口消除、host ASCII 小写、UTF-8 percent-encoding、多斜线保留、query 多值顺序与稳定 `sort()` 语义；只保证 `http:` 和 `https:` URL 用于标准网络 API。
- **EC-WEBAPI-API-002**：`Headers` 必须支持标准 constructor、`append`、`delete`、`get`、`has`、`set`、`entries`、`keys`、`values`、`forEach` 和迭代器。name 按 ASCII 小写，value 去除首尾 HTTP whitespace，重复普通字段按加入顺序以 `, ` 合并，迭代使用 Fetch 标准的 sort-and-combine 结果。
- **EC-WEBAPI-API-003**：`Request` constructor 必须接受绝对 HTTP(S) string 或 `Request`，以及 `method`、`headers`、`body`、`redirect`、`signal`；新建对象默认 GET 与 `follow`。标准可观察属性为 `url`、`method`、`headers`、`body`、`bodyUsed`、`redirect`、`signal`，方法为 `clone`、`arrayBuffer`、`blob`、`formData`、`json`、`text`。GET/HEAD 不得带 body，method 使用 Fetch 标准规范化。
- **EC-WEBAPI-API-004**：`Response` constructor 必须接受 null、string、`ArrayBuffer` 或 `Blob` body，以及 `status`、`statusText`、`headers`；标准可观察属性为 `body`、`bodyUsed`、`headers`、`ok`、`redirected`、`status`、`statusText`、`url`，方法为 `clone` 和与 Request 相同的五种 body reader。静态 `error()` 与 `redirect(url, status)` 必须可用，redirect status 只接受 301、302、303、307、308。
- **EC-WEBAPI-API-005**：`TextEncoder` 必须只产生 UTF-8，并支持 `encode`、`encodeInto` 与 `encoding`；`TextDecoder` 必须至少支持 UTF-8、`fatal`、`ignoreBOM`、流式 `decode` 和对应只读属性。非 fatal 解码用 U+FFFD 替换无效序列，fatal 解码拒绝无效序列。
- **EC-WEBAPI-API-006**：`atob`/`btoa` 只实现 HTML 标准 binary-string/base64 语义；它们不是 UTF-8 文本编解码器。空白按标准忽略，无效 base64 或 `btoa` 输入中大于 U+00FF 的 code unit 必须失败。
- **EC-WEBAPI-API-007**：`AbortController`/`AbortSignal` 必须支持创建 signal、读取 `aborted`、一次性分发 `abort` 事件，以及把 signal 传给 Request/fetch。没有显式 abort 时不得自行改变 signal 状态；`reason`、`throwIfAborted()`、`timeout()` 与 `any()` 尚不在本 Draft 保证内。
- **EC-WEBAPI-API-008**：全局 `crypto` 必须提供 `getRandomValues`、`randomUUID` 和 `subtle.digest("SHA-256", data)`；UUID 必须为 RFC 4122 variant 的随机 version 4 文本，digest 返回精确 32 octet。其他算法与供应商扩展不在本 Draft 保证内。
- **EC-WEBAPI-API-009**：全局 `fetch(input, init)` 必须接受绝对 HTTP(S) string 或 Request，返回兑现为 Response 的 Promise，并实现 `follow`、`manual`、`error` redirect mode。301/302 的 POST 和 303 的非 GET/HEAD 按 Fetch 标准转为 GET，307/308 保留 method/body。
- **EC-WEBAPI-API-010**：必须提供 `setTimeout`、`clearTimeout`、`setInterval` 与 `clearInterval`。回调只可在当前同步 turn 完成后执行；标准不保证亚毫秒精度、恰好执行时刻或不同 isolate 之间的时钟顺序。

`ReadableStream` body、流式编解码、Compression Streams、WebSocket 和后台任务由 `streams-websockets-background-work` 定义。本草案承认 body 属性存在，但不提前冻结完整 Streams API。

## 2. 错误

- **EC-WEBAPI-ERR-001**：无效 URL、method、header name/value、GET/HEAD body 和不满足类型/语法的 Request/Response init 必须同步抛出 `TypeError`；Fetch 标准明确规定的越界 Response status 或非法 `Response.redirect` status 必须同步抛出 `RangeError`。不得接受后再由供应商静默修正。
- **EC-WEBAPI-ERR-002**：body 第一次完整读取后必须为已消费；第二次读取或在已消费/locked body 上 clone 必须以 `TypeError` 失败。无效 JSON 以 `SyntaxError` 失败，fatal UTF-8 解码以 `TypeError` 失败，且错误不得返回部分解析值。
- **EC-WEBAPI-ERR-003**：网络错误、`redirect: "error"` 遇到 redirect 和在完成前 abort 的 fetch 必须拒绝 Promise；它们不得兑现为伪造的 HTTP Response。abort 拒绝必须是 name 为 `AbortError` 的 `DOMException`。

## 3. 并发、一致性与顺序

- **EC-WEBAPI-CON-001**：Request/Response `clone()` 必须在 body 未使用时产生可独立消费的分支；任一分支消费或 header 修改不得消费或修改另一分支。克隆不能重新执行原 fetch。
- **EC-WEBAPI-CON-002**：同一输入与锁定标准版本必须产生相同 URL serialization、Headers sort-and-combine、method normalization、文本编码和 SHA-256 digest；locale、OS、供应商、边缘位置和并发调度不得改变结果。
- **EC-WEBAPI-CON-003**：并发 fetch 可以以任意顺序完成，但每个 Promise 必须只关联其请求的 status、headers 和 body；一个请求的 abort、network error 或 body 消费不得串到另一请求。

## 4. 生命周期

- **EC-WEBAPI-LIFE-001**：纯 constructor、URL/header/text/base64 变换可在模块初始化或请求处理期间使用；发起网络 I/O 的 `fetch` 只能在有效调用生命周期内开始。后端必须在生成供应商产物时建立正确 request context，不能让同一应用因供应商而改变调用位置。
- **EC-WEBAPI-LIFE-002**：AbortSignal 只影响显式关联的进行中操作。操作已兑现或拒绝后再 abort 不得改写既有结果；定时器被 clear 后不得执行其尚未开始的回调。

## 5. 最低资源保证

- **EC-WEBAPI-LIMIT-001**：Request 与 Response 的每一种完整 body reader 必须能够处理至少 1,000,000 octet 的有效输入；应用不得从本条推断第 1,000,001 octet 可移植。更大 body 应使用未来冻结的 Streams 子集。
- **EC-WEBAPI-LIMIT-002**：Headers 必须接受至少 128 个 ASCII token 字符的单个 name 和至少 4,095 个可打印 ASCII 字符的单个 value；总 header 数量与总字节保证尚未冻结。
- **EC-WEBAPI-LIMIT-003**：`crypto.getRandomValues` 必须接受所有标准整数 TypedArray 且单次最多 65,536 octet；大于 65,536 octet 必须以 name 为 `QuotaExceededError` 的 `DOMException` 拒绝。

## 6. 安全与隔离

- **EC-WEBAPI-SEC-001**：自动跟随到不同 origin 的 redirect 时，必须删除 `Authorization`、`Proxy-Authorization` 和 `Cookie` 等 Fetch 标准 credential header；供应商原生实现即使会转发也不得覆盖本条。需要自定义信任策略的应用必须使用 `manual` 并显式构造下一请求。
- **EC-WEBAPI-SEC-002**：`getRandomValues` 必须使用密码学安全随机源；安全 token 不得由打包器降级为 `Math.random()`。SHA-256 输入和输出必须局限于调用提供的 buffer，不得复用另一调用的明文或 digest。
- **EC-WEBAPI-SEC-003**：header 中的 NUL、CR 或 LF、无效 token name 和 URL 中的凭证传播不得因供应商宽松解析而进入网络请求。标准诊断不得包含完整 credential header、body 或 secret query value。

## 7. 失败与恢复

- **EC-WEBAPI-FAIL-001**：一个 fetch 的 abort、网络错误或解析失败只终止该操作及其派生 body；不得取消未关联的 fetch、timer 或其他调用，也不得自动重放应用请求。
- **EC-WEBAPI-FAIL-002**：body reader、decoder 或 JSON parser 失败后，body 仍视为已消费；运行时不得返回部分值、旧缓存 body 或供应商错误页作为恢复结果。
- **EC-WEBAPI-FAIL-003**：标准 fetch 必须访问应用指定并经 redirect 规则得到的 URL。供应商 CDN cache、隐式回源、图片处理或内部 service shortcut 只有经其他标准能力显式请求时才可介入；本 API 不因 Host 相同而自动改变目标语义。

## 8. 升级与迁移

- **EC-WEBAPI-UPG-001**：capability lock 必须包含受支持的 `edge-canon.web-platform-apis` major、精确 Edge Canon commit 和本版本选取的上游基线日期；未知 major、浮动版本和未知字段必须在执行应用代码前拒绝。
- **EC-WEBAPI-UPG-002**：provider packager 必须从锁定版本派生兼容日期、feature flag 与必要 shim；例如 Cloudflare 的 `URL` 与 `Response.redirect()` 都必须使用标准 URL parser。不能让账户默认值、部署日期或原生 CLI 新版本静默改变应用语义。
- **EC-WEBAPI-UPG-003**：供应商附加字段/方法可以作为非标准实现细节存在，但标准类型与应用不得依赖、探测或据其分支。把新共同 API 纳入应用面必须发布新 Edge Canon 版本并扩充相同 oracle。

## 9. 晋级条件

进入 `normative-complete` 前仍需：

1. 冻结 total header、URL、response body、timer、网络 timeout 与 FormData multipart 的共同最低保证及超限错误；
2. 完成 Streams family，从“body 属性存在”升级为完整、可移植的流式语义；
3. 为 Cloudflare 的跨 origin credential redirect 与 EdgeOne 的 Request clone/header 差异实现并审计 provider shim；
4. 在 Cloudflare、EdgeOne 与 Deislet 真实部署运行相同 URL、headers、body、abort、crypto、redirect 和并发 oracle；
5. 证明 provider CLI/compatibility date 升级不会改变已锁定版本，并对上游 living standard 变更建立差异审查。
