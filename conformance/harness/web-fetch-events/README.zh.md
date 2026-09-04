# EC-WEB 可执行 harness 草案

本目录把描述性用例推进为一个可执行、供应商无关的 observation/oracle 边界。当前 fixture/oracle 已覆盖 `EC-WEB-T001` 至 `T014`，状态仍是 Draft；没有任何完成真实部署取证的 provider adapter，因此不能产生 conformance-passed 证据。

## 固定边界

1. 每个 adapter 部署同一份 `fixture.mjs` 及其相对模块依赖，不能改写 handler、工作负载或断言。
2. adapter 可以在内部调用固定版本的官方 CLI 或 API，例如 Wrangler、EdgeOne CLI/API 或 Deislet CLI；它只负责打包、部署、调用、读取结构化执行证据和清理。
3. adapter 输出符合 `schemas/conformance-observations.schema.json` 的原始观察，不能输出自行判定的 pass/fail。
4. `oracle.mjs` 是唯一结果判定器。运行：

   ```bash
   node conformance/harness/web-fetch-events/oracle.mjs observations.json
   ```

5. `artifactSha256` 必须是 adapter 实际部署的 canonical artifact 摘要；`backend.standardVersion` 必须是 `edge-canon.next@<40 位 source commit>`，不接受浮动的 `next` 或 `latest`。`evidenceRefs` 指向构建、部署、调用或日志原件。
6. adapter 无法读取 failure code、origin hit count 等观察时，该用例失败或保持未执行，不能用供应商错误页文本猜测，也不能省略字段后宣称通过。

T012 先在 adapter 所在执行机运行 `node conformance/harness/web-fetch-events/calibrate-cpu.mjs`，把输出的 iterations 注入 `CPU_ITERATIONS`；`measuredCpuMilliseconds` 必须来自后端自身 CPU 计量，adapter 还须保存校准工作负载摘要和 fresh execution environment 证据，wall time 不可代替。T013 固定为 48 个直接 fetch 加一个发生一次跳转的 fetch，即 49 次 API 调用、50 个计入预算的子请求。T014 的受控 origin 必须在放行响应头前保存已有连接数，不能从最终成功数倒推并发。

`sample-pass.json` 只用于 oracle 自测，不是任何后端的运行证据。后续仍必须为三个一等后端各自实现 adapter 并真实运行全部用例，才能把 harness 标为 Complete。
