# EC-STREAM provider runtime 执行协议

本协议把同一份 EC-STREAM 标准应用送入不同后端，并用同一个 oracle 判断应用实际可见的流、响应与全局对象语义。它是 reference harness 的真实运行时补充，不把部分运行证据冒充完整套件通过。

## 固定输入

- 应用入口：[`provider-runtime-fixture.mjs`](provider-runtime-fixture.mjs)
- 结果判定：[`provider-runtime-oracle.mjs`](provider-runtime-oracle.mjs)
- handler 模型：`export default async function ({ request, context })`
- 请求路径：`/?label=A`、`/?label=B`、`/stream`、`/capacity`

准备阶段必须保持 fixture 字节不变。适配器可以生成供应商入口薄层，也可以调用锁定版本的供应商 CLI，但不能改写夹具、降低断言或让供应商 WebSocket 全局重新进入应用可见面。构建产物必须是随后实际部署和调用的同一份不可变产物，证据必须绑定精确标准提交、产物 SHA-256、provider 实现版本和部署身份。

## 执行顺序

1. 对精确标准提交、fixture、编译器、运行时和供应商 CLI 记录版本及摘要。
2. 在隔离测试 namespace 中部署不可变产物，并保存 provider 返回的部署身份。
3. 同时发起 `?label=A` 与 `?label=B`，原样保存两个 JSON 响应；不能串行调用来掩盖跨请求污染。
4. 调用 `/stream`。客户端必须在响应体结束前观察到状态与响应头，并记录完整响应体、是否发生替代响应以及 `x-edge-canon-case`。
5. 调用 `/capacity`。保存完整 65,536 字节响应体的长度与 SHA-256，并把两个容量响应头解析成整数。
6. 把元数据、两个 probe、stream 和 capacity 事实组成单一证据 JSON，执行：

   ```bash
   node provider-runtime-oracle.mjs evidence.json
   ```

7. 原样保存请求时间、HTTP 原始事实、oracle 输出和清理结果；清理失败进入运维告警，不得改写判定。

## 证据字段与判定边界

顶层只允许 `schemaVersion`、`standardVersion`、`artifactSha256`、`provider`、`probes`、`stream` 和 `capacity`。`standardVersion` 必须是 `edge-canon.next@<40 位提交>`；`provider` 必须包含非空的 `id`、`implementationVersion` 和 `deploymentId`。

通过结果固定为 `runtime-partial-pass`。当前真实运行时部分可证明 T001、T002、T004、T010，T003 的顺序与锁释放、T006 的流式响应、T009 的 stream canary，以及 T011 的字节约束和供应商全局隔离。以下事实仍须由受控 provider 客户端、生命周期证据 sink 或部署前编译证据补齐：

- T003 的背压并发上限；
- T005 的 source error、cancel 和 abort 传播；
- T006 已提交响应的 body error；
- T007 的全部后台任务独立结算；
- T008 的关闭后注册拒绝；
- T009 的后台任务和 context 身份隔离；
- T012 的崩溃丢失且不重试；
- T011 的源代码拒绝策略；
- T013 的 capability lock 与 provider 派生一致性。

本地 workerd、Deno 或 Deislet 运行只能形成开发期 runtime 证据，不能代替真实供应商账户部署。后端只有在本协议证据、部署前构建拒绝用例及其余生命周期断言全部通过后，才能获得完整 EC-STREAM 合规结论。
