# Edge Canon Conformance Registry

[`registry.json`](registry.json) 是后端实现证据与认证状态的唯一机器可读入口。平台矩阵可以解释能力差异，但不能自行产生合规或支持声明。

[`kit.json`](kit.json) 是标准测试集索引。它把能力族连接到 provider-independent 用例；`EC-WEB` 已有覆盖 T001–T015 的统一 fixture、原始 observation 格式和可执行 oracle。三个一等后端已有受 schema 和治理约束的 Draft manifest，以及可执行的安全 `inspect`/`preflight`、确定性 `prepare`、碰撞保护的 `deploy` 和不可盲目重放的统一 `invoke`；Cloudflare 与 Deislet 另有身份绑定的 `collect`、`cleanup` 和可恢复 `run`。EdgeOne 的 `collect`、公开清理路径、`run` 及三个后端的真实账户证据仍未完成，完成 adapter 列表因此仍为空。

`EC-ARTIFACT` 已有本地 reference builder、validator 和覆盖 T001–T008 的可执行 Draft，检查规范清单、确定性、原子发布、路径可移植性、secret canary、篡改和迁移；它还不是三个 provider packager 或真实框架 adapter 的通过证据。其余 13 个能力族尚未执行化。所有本地驱动和 oracle 自测都不能自行提高后端成熟度或认证状态。

证据成熟度依次为：

1. `artifact-generated`：从 canonical artifact 生成派生产物并完成自身完整性检查；
2. `syntax-verified`：供应商官方 CLI/API 接受待部署的精确产物；
3. `deployed`：精确产物进入真实测试环境并通过身份与基础 smoke；
4. `conformance-passed`：指定标准版本全部 mandatory suites 通过。

这些级别记录“已经证明到哪里”，不是功能 profile。只有最后一级且记录未过期，才可令 `compliant` 为 `true`；`supported` 还要求对应 driver/runtime 在维护和安全支持窗口内。

首版 registry 对已有仓库证据采取保守解释。Deislet 单机 demo 记录为 `deployed`；其他产物生成或条件式供应商检查没有不可变、可复验的本次证据包，因此只记录 `artifact-generated`。所有实现均未运行 `edge-canon.next` 完整测试集，所以没有合规或正式支持声明。

运行校验：

```bash
python3 scripts/check-governance.py
node --test
```

治理校验使用固定版本的 JSON Schema validator，检查契约、逐条要求、测试集、harness、三个 adapter manifest 与实现 registry 的交叉约束；Node 测试执行当前 fixture/oracle 草案的正反自证、adapter 子进程安全边界和 canonical build output 完整性检查。JSON Schema 同时是 artifact、adapter request/result 和外部生成客户端使用的公开格式定义。
