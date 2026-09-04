# Proposal 0001：统一的跨平台 Edge 应用契约

- 阶段：Draft
- 创建日期：2026-09-03
- 目标版本：`edge-canon.next`
- 讨论状态：等待独立标准治理审查
- 实现输入：[Deislet ADR 决策集](https://github.com/deislet/deislet/tree/main/docs/adr)

## 摘要

Edge Canon 的下一个版本采用一个统一、版本化的应用标准。应用不能选择供应商 profile，也不能依赖运行时能力探测来决定其业务路径。Cloudflare Workers/Pages、Tencent EdgeOne Makers、Deislet 及后续后端必须为同一组规范语义提供恰当实现；实现可以使用供应商原生能力、组合多个原生能力，或由受控 companion service 补齐。

标准能力取有限参考供应商主流语义的交集，经公开提案、规范审查、多后端实现和黑盒一致性测试后进入不可变发布。供应商的产品名、SKU 或偶然限制不是标准 API。

标准资源保证以每个参考供应商面向一般用户开放的最低免费档或入门档为基线。所有参考供应商的该档位都必须兑现同一保证；需要更高付费档才能满足的数值不得进入本版本的可移植应用契约。若任何一家的公开材料没有给出可依赖下限，该项保持发布阻断，而不是由实现经验或其他供应商上限代填。更高套餐仍可提供额外运营容量，但应用不得把它视为跨后端保证。

本 proposal 建立迁移边界和发布门槛，不把尚未写出的 API 细节伪装成已完成规范。完整的 API、错误、并发与一致性、生命周期、资源保证、fixture 和 oracle 必须在本 proposal 晋级前逐项成为可链接的规范条款。

## 与 v0.1 文档的关系

当前 `SPECIFICATION_BASIC.md` 与 `SPECIFICATION_EXT.md` 仍是 v0.1 的历史规范文本。其“基础规范 + 可选扩展”模型与本 proposal 不兼容。迁移期间：

1. v0.1 文档继续用于解释已有实现，不代表 `edge-canon.next`。
2. `edge-canon.next` 不发布 optional capability profile。
3. 旧平台矩阵只能作为供应商证据输入，不能产生合规结论。
4. 任何实现只有在指定完整版本的 mandatory suites 全部通过且证据仍有效时，才可称为 compliant；产品支持还要求实现处于维护与安全支持窗口。

## 统一契约

机器可读入口是 [`standard/contract.json`](../../standard/contract.json)。逐条要求由
[`standard/requirements.json`](../../standard/requirements.json)登记，测试入口由
[`conformance/kit.json`](../../conformance/kit.json)登记。它们共同约束：

- 单一标准与禁止 profile；
- 标准版本、治理阶段和参考供应商；
- 必须定义的能力族及每个能力族必须覆盖的语义维度；
- canonical artifact、逻辑资源绑定和统一部署生命周期；
- 完整版本认证、证据新鲜度及支持状态的派生规则。

契约中的 `definitionStatus: pending` 是发布阻断项，不是可选能力。`draft` 只表示已有可审查候选文本，同样不构成合规基础。全部必需条目达到 `normative-complete`、获得对应 fixture/oracle 和可执行 harness，并由首批三个后端实现后，才可进入 release candidate。

当前 `web-fetch-events` 已有[候选要求](../../standard/requirements/web-fetch-events.zh.md)、15 项机器可读用例和覆盖全部草案用例的可执行 fixture/oracle；三个 provider adapter 已登记固定工具版本，并已实现受约束的检查、派生产物、真实部署与调用边界，Cloudflare/Deislet 已接入单次 CPU 取证且 Deislet/Cloudflare 有清理路径，但全流程编排、EdgeOne 单次 CPU 与公开清理 API、三个真实账户证据仍未闭环。最低资源保证也只有 CPU、子请求、外连并发和 identity/已知长度的 1,000,000 octet 请求 body 四个 Draft 下限，其余 body 变体与超限处理、响应大小、wall time、应用可用内存和 `waitUntil` 尚未完成。

`routing-static-assets`、`canonical-build-artifact`、`web-platform-apis`、`streams-websockets-background-work` 与 `node-npm-subset` 均已进入 Draft，并分别具有机器可读 schema、case、reference harness、provider-independent oracle 以及 Linux、macOS、Windows 同源 reference evidence；Node/npm 的三平台证据使用同一个经校验的 Node 24.20.0 语义运行时。Streams family 固定共同 identity Streams 与 best-effort `waitUntil` 子集，并明确把没有参考供应商运行时交集的 WebSocket 判为预部署拒绝；Node/npm family 固定逐 export 子集和构建期 package-lock v3 解析，不把 import-only stub 当作支持。另有 9 个 mandatory capability family 仍为 `pending`，所有 Draft 也都缺三个一等后端的真实完整证据，因此 proposal 不能被实现或市场材料解释为已经支持。

## 首批实现范围

首批一等实现为：

- Deislet；
- Cloudflare Workers/Pages；
- Tencent EdgeOne Makers。

Deno 作为实验实现和行业证据来源保留，但不阻断首个版本发布。所有一等实现接受完全相同的标准测试；provider harness 只负责供应、部署、调用、故障注入、清理和证据采集，不改变断言。

## 规范工作包

每个能力族必须同时交付以下内容：

1. API 与输入输出类型；
2. 错误分类及可重试性；
3. 并发、一致性与顺序保证；
4. 资源生命周期、删除、恢复与迁移；
5. 版本化最低资源保证；
6. 正常、边界、故障、安全与升级 fixture；
7. provider-independent oracle；
8. 三个首批后端的实现映射和已知阻断项。

具体工程顺序由 Deislet 的[产品级路线](https://github.com/deislet/deislet/blob/main/docs/product/roadmap.zh.md)跟踪；标准仓库只决定规范及认证，不接管单个实现的排期。

## 决策依据

本 proposal 的产品输入是 Deislet `docs/adr/001-*.md` 至 `022-*.md` 的 Accepted ADR 集合；ADR-022 局部取代 ADR-005 的套餐基线与认证粒度结论。它们说明为何选择当前方向；本仓库经独立治理形成的规范文本、schema、fixture 与 oracle 才是应用契约的最终真源。

## 晋级条件

- Draft → Candidate：能力族无 `pending` 定义；所有规范条款有稳定标识；schema、fixture 和 oracle 可执行；至少两个独立实现给出实现反馈。
- Candidate → Release Candidate：三个首批后端实现完整能力；mandatory suites 无 skip/quarantine/语义 waiver；安全与失败恢复套件可重复。
- Release Candidate → Standard：签名认证记录有效；升级/兼容策略完整；Deislet 编译器只按该标准版本验证，不读取供应商能力 profile。

任何阶段都不能用文档表格、artifact 生成或供应商 CLI 语法检查替代完整认证。
