# Edge Canon Conformance Registry

[`registry.json`](registry.json) 是后端实现证据与认证状态的唯一机器可读入口。平台矩阵可以解释能力差异，但不能自行产生合规或支持声明。

[`kit.json`](kit.json) 是标准测试集索引。它把能力族连接到 provider-independent 用例；当前只有 `EC-WEB` 存在草案用例，且所有 provider harness 仍为 `planned`。机器可读用例不是执行证据，不能据此提高任何后端的成熟度或认证状态。

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
```

该校验只使用 Python 标准库，检查契约、逐条要求、测试集与实现 registry 的交叉约束；JSON Schema 仍是外部工具和生成客户端使用的公开格式定义。
