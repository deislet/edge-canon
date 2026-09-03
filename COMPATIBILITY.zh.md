# Node.js 兼容性策略

> **版本边界：** 本文是 v0.1 兼容策略。下一标准版本将以 Node 24 LTS 为初始
> 基线定义版本化 Node/npm subset，迁移由
> [Proposal 0001](proposals/0001-unified-platform-contract/README.zh.md)跟踪。

> **核心理念**：保持运行时纯净（仅支持 Web 标准），利用编译器解决生态兼容问题。
>
> [English](./COMPATIBILITY.md)

本文档概述了 Edge Canon 环境中处理 Node.js 生态兼容性的策略，确保在不破坏“一次编写，随处部署”原则的前提下支持现有生态。

---

## 1. 挑战

现代边缘运行时（Cloudflare Workers, Deno Deploy, Denix）建立在 **Web 标准**（Fetch, WebCrypto, Streams）之上，而非 Node.js API。然而，巨大的 npm 生态系统严重依赖 Node.js 特有的模块（如 `buffer`, `util`, `events`, `process`）。

**严格策略**：Edge Canon 运行时特意**不**内置 Node.js API，以确保可移植性和安全性。

## 2. 兼容性策略

我们采用三层非侵入式策略来支持生态系统：

### 策略 A：构建时 Polyfill（推荐）

利用 `deforge` 编译器，在构建过程中自动注入 Node.js 核心模块的纯 JavaScript 实现。

*   **机制**：
    *   当编译器遇到 `import { Buffer } from 'buffer'` 时，自动重写为使用用户态 polyfill（如 `npm:buffer`）。
    *   全局对象如 `process.env` 会被静态替换为定义的环境变量或 `import.meta.env`。
*   **优点**：
    *   **运行时纯净**：运行时本身无需包含“脏”的 Node 兼容层。
    *   **广泛兼容**：修复了约 90% 的旧版包（如 `jsonwebtoken`, 旧版 `uuid`）。
*   **缺点**：
    *   **包体积**：Polyfill 会增加最终产物的体积。

### 策略 B：WinterCG / 现代生态（最佳实践）

鼓励并引导开发者使用原生支持边缘运行时的 "Winter-compatible" 库。

*   **机制**：
    *   CLI 工具 (`denictl`) 会识别过时的重型库，并建议现代替代品。
*   **替换指南**：
    *   `jsonwebtoken` (Buffer 依赖) → **`jose`** (原生 WebCrypto)
    *   `express` (Node http) → **`hono`** (标准 Req/Res)
    *   `pg` (net socket) → **`postgres.js`** (边缘兼容) 或平台数据库服务
*   **优点**：
    *   **零开销**：无 polyfill，性能最高。
    *   **面向未来**：符合 WinterCG 标准。

### 策略 C：WebAssembly / Wasm（原生性能）

针对无法 polyfill 的计算密集型或系统级任务（如图像处理、重型加密）。

*   **机制**：
    *   将 C++/Rust/Go 代码编译为 `.wasm` 模块。
    *   通过标准 ESM 导入：`import mod from './lib.wasm'`。
*   **场景**：
    *   图像缩放（替换 `sharp`）
    *   PDF 生成
    *   复杂算法
*   **优点**：
    *   **真正可移植**：相同的字节码在任何地方运行。
    *   **性能**：接近原生速度。

---

## 3. 实施计划

### `deforge` (编译器)
*   [ ] 默认启用 **Auto-Polyfill**：`buffer`, `events`, `util`, `path`, `url`, `string_decoder`。
*   [ ] 对无法 polyfill 的模块报错：`fs`, `net`, `child_process`, `cluster`, `dgram`。

### `denictl` (CLI)
*   [ ] 添加 **"生态审计"**：扫描 `package.json` 并警告非边缘友好的依赖。
    *   *示例*："警告：检测到 `express`。此库显著增加包体积。建议在边缘环境使用 `hono`。"

### `edge-canon` (标准)
*   [ ] 保持对 Web 标准的严格遵守。
*   [ ] 显式支持 `.wasm` 导入（v1.1 完成）。
