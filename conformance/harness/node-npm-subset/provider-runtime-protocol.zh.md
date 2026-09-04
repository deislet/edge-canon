# EC-NODE provider runtime 执行协议

本协议把同一份标准应用送入不同后端，并用同一个 oracle 判断应用可见语义。它只覆盖必须在 provider runtime 中观察的 T001–T007 与 T012；T008–T011、T013–T015 是构建、供应链和配置拒绝用例，必须由部署前编译流程另行执行。两部分都通过之前，后端不能获得 EC-NODE 合规结论。

## 固定输入

- 应用入口：[`provider-runtime-fixture.mjs`](provider-runtime-fixture.mjs)
- 只读依赖：[`fixture.mjs`](fixture.mjs)
- 结果判定：[`provider-runtime-oracle.mjs`](provider-runtime-oracle.mjs)
- handler 模型：`export default async function ({ request, context })`
- Node 语义基线：`24.20.0`
- 初始逻辑绑定：`SHARED=initial`

准备阶段必须保持这两个源文件的字节和相对 import 关系。适配器可以生成供应商入口薄层，也可以调用锁定版本的供应商 CLI，但不能改写 fixture、减少用例或把宿主 `process` 暴露给应用。构建产物必须是随后实际部署和调用的同一份不可变产物。

## 执行顺序

1. 对精确标准提交、fixture、依赖文件、编译器与供应商 CLI 记录 SHA-256/版本。
2. 在隔离的测试 namespace 中准备并部署产物，取得不可变部署身份。
3. 同时发起 `?label=A` 与 `?label=B` 两个请求；不允许先后串行执行来掩盖 context 泄漏。
4. 原样保存两个 HTTP 响应、状态、响应头、调用时间和部署身份。非 2xx、非 JSON 或重复 label 都是失败。
5. 执行：

   ```bash
   node provider-runtime-oracle.mjs response-a.json response-b.json
   ```

6. 保存 oracle 输出后清理测试部署；清理失败也必须进入证据和运维告警，不能改写通过结果。

## 判定边界

oracle 要求两个响应各自只包含固定字段和 T001–T007；它逐 export 检查 18 个选中模块，复用 reference oracle 检查 T002–T007，并把两个 invocation 合成为 T012。A 修改 `SHARED` 后 B 仍须看到 `initial`，两次调用的 process、path、URL 与 builtin identity 必须完全一致。

[Cloudflare Workers 的公开 API](https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/)明确不实现 `AsyncLocalStorage.enterWith()` 与 `disable()`，因此它们不在统一应用标准中；T007 验证领先后端共同提供的 `run/getStore/exit`。供应商特有方法即使在某个后端存在，也不能进入 fixture 或合规声明。

本地 workerd、Node 或 Deno 执行只能形成开发期 runtime 证据，不能代替真实账户部署。认证包还必须同时包含该 provider 的完整构建用例、远端部署身份、原始响应、oracle 输出与清理记录。
