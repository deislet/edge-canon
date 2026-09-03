# Edge Canon

> 通用边缘函数权威规范。
>
> [English](./README.md)

**Edge Canon** 是一个统一的边缘函数编写标准，旨在实现“一次编写，随处运行”——无论是 Cloudflare、Deno、腾讯 EdgeOne 还是 **Deislet**。

> **演进说明：** v0.1 文档继续描述已有实现。下一版本按单一能力集合、无
> Basic/Extended profile 的方向在 [Proposal 0001](proposals/0001-unified-platform-contract/README.zh.md)
> 中制定；机器可读[契约](standard/contract.json)和[一致性 registry](conformance/registry.json)
> 当前均为 proposal，不构成已发布的兼容性声明。

## 文档索引

*   📜 **[SPECIFICATION](./SPECIFICATION.zh.md) (核心规范)**  
    这是“法典”。定义了项目结构、Handler 接口以及 KV、数据库等标准服务接口。

*   🧠 **[PRINCIPLES](./PRINCIPLES.zh.md) (设计原则)**  
    设计哲学与参考架构。解释了架构决策背后的“为什么”。

*   🔄 **[COMPATIBILITY](./COMPATIBILITY.zh.md) (兼容性指南)**  
    关于 Node.js 兼容性迁移和生态适配的详细指南。

*   📐 **[schemas](./schemas)**  
    用于验证配置文件的 JSON Schema 定义。

*   🧪 **[fixtures](./fixtures)**  
    标准代码示例与合规性测试用例。

---

*"Write Once, Run Anywhere."*
