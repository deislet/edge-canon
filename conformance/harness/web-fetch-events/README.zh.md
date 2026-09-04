# EC-WEB 可执行 harness 草案

本目录把描述性用例推进为一个可执行、供应商无关的 observation/oracle 边界。当前只覆盖 `EC-WEB-T001` 至 `T005`，状态是 Draft；没有任何 provider adapter，因此不能产生 conformance-passed 证据。

## 固定边界

1. 每个 adapter 部署同一份 `fixture.mjs`，不能改写 handler 或断言。
2. adapter 可以在内部调用固定版本的官方 CLI 或 API，例如 Wrangler、EdgeOne CLI/API 或 Deislet CLI；它只负责打包、部署、调用、读取结构化执行证据和清理。
3. adapter 输出符合 `schemas/conformance-observations.schema.json` 的原始观察，不能输出自行判定的 pass/fail。
4. `oracle.mjs` 是唯一结果判定器。运行：

   ```bash
   node conformance/harness/web-fetch-events/oracle.mjs observations.json
   ```

5. `artifactSha256` 必须是 adapter 实际部署的 canonical artifact 摘要；`backend.standardVersion` 必须是精确版本，不接受 `latest`。`evidenceRefs` 指向构建、部署、调用或日志原件。
6. adapter 无法读取 failure code、origin hit count 等观察时，该用例失败或保持未执行，不能用供应商错误页文本猜测，也不能省略字段后宣称通过。

`sample-pass.json` 只用于 oracle 自测，不是任何后端的运行证据。后续必须为三个一等后端各自实现 adapter，并覆盖 T006–T014，才能把 harness 标为 Complete。
