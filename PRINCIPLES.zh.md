# Edge Canon 设计原则与哲学

> Edge Canon 规范的架构基石。
> 
> [English](./PRINCIPLES.md)

## 1. 核心哲学

**Edge Canon** 建立在一个不容妥协的承诺之上：**"Write Once, Run Anywhere" (一次编写，随处运行)。**

为了在碎片化的边缘计算领域（Cloudflare, Deno, 腾讯 EdgeOne 等）实现这一目标，我们坚持以下三大原则：

### 1.1 "最小公分母" 策略
规范仅暴露那些能够被所有主流边缘平台可靠实现的特性。
*   **是**: `fetch`, `Request/Response`, `ReadableStream`, `crypto.subtle`.
*   **否**: `fs.readFileSync` (Node.js 特有), `eval` (安全风险), 平台特有的专有 API。

### 1.2 零平台泄漏 (Zero Platform Leakage)
你编写的代码绝不能知道它当前运行在*哪里*。
*   **禁止**: `if (typeof Cloudflare !== 'undefined')`
*   **禁止**: 基于环境的条件导入。
*   **强制**: 编译器 (`deforge`) 会主动扫描并拒绝平台特有的全局对象。

### 1.3 编译时能力协商
我们使用**编译时协商**来代替运行时的特性检测（"我能用数据库吗？"）。
*   开发者在 `.config.json` 中声明所需服务（KV, DB, Queue）。
*   编译器验证目标平台是否支持这些服务。
*   如果平台无法满足契约，构建将立即失败。

---

## 2. 抽象资源模型

Edge Canon 定义了一个抽象资源模型，将应用逻辑与基础设施解耦。

### 2.1 Context 对象
应用所需的一切都通过 `Context` 对象注入。这是通往外部世界的**唯一**桥梁。

```typescript
// Edge Canon 函数眼中的"世界"
interface Context {
  // 输入
  request: Request;
  env: Record<string, string>;
  
  // 资源
  services: {
    kv?: KVStore;      // 抽象 Key-Value
    database?: Database; // 抽象 SQL
    blob?: BlobStore;  // 抽象对象存储
    queue?: Queue;     // 抽象消息队列
  };
  
  // 输出/副作用
  log: Logger;
  waitUntil(promise: Promise<any>): void;
}
```

### 2.2 服务绑定 (Service Binding)
*   **代码视角**: `context.services.kv.get('key')`
*   **Cloudflare 实现**: 映射到 `env.NAMESPACE.get('key')`
*   **Deno 实现**: 映射到 `Deno.openKv().get(['key'])`
*   **Deislet 实现**: 映射到宿主进程的 gRPC/Syscall 调用。

这种间接层允许底层实现发生变化，而不影响应用代码。

---

## 3. 隔离与安全模型

虽然 `Edge Canon` 不强制要求特定的隔离技术（Isolate vs Container），但它假设了一个 **Shared-Nothing（无共享）架构**。

### 3.1 状态管理
*   **无状态计算**: Handler 是短暂的。全局变量不保证在请求之间持久化。
*   **外部状态**: 所有状态必须存储在附加服务中 (KV, DB)。

### 3.2 安全边界
*   **无文件系统访问**: 函数不能读写任意文件（使用 Blob Store）。
*   **无套接字访问**: 原始 TCP/UDP 套接字通常被限制（使用 `fetch` 或数据库驱动）。
*   **禁止进程创建**: 禁止使用 `child_process`。

---

## 4. 生态兼容性

### 4.1 Node.js 问题
绝大多数 JavaScript 库假设了 Node.js 环境。Edge Canon 通过**编译器驱动的 Polyfill 策略**来解决这个问题。

*   **标准库**: 我们*不*在运行时中内置 Node.js API。
*   **Polyfill**: 编译器 (`deforge`) 在构建时注入安全 API (`path`, `url`, `events`, `buffer`) 的用户态实现。
*   **拒绝**: 不安全的 API (`fs`, `net`, `child_process`) 会被拒绝。

### 4.2 Web Assembly (Wasm)
Wasm 被视为一等公民，用于处理超出 JavaScript 能力的可移植、高性能计算任务（图像处理、压缩、加密）。

---

## 5. 参考实现：Deislet

**Deislet** 是 Edge Canon 的参考实现 (Reference Implementation)。它证明了该规范可以在自托管技术栈上落地。

*   **角色**: 验证规范的可行性，并为测试提供一个“本地”目标。
*   **合规性**: Deislet 通过将 `Edge Canon` 接口映射到基于 Rust 的后端服务，实现了 100% 的合规性。

| Canon 接口 | Deislet 实现 |
|:---|:---|
| `Context` | `denix` (V8 Runtime 封装) |
| `KVStore` | `denira` (基于 SQLite 的 KV) |
| `Routing` | `deflux` (基于 Pingora 的 LB) |

*注：Deislet 的内部架构（负载均衡器、Supervisor 等实现细节）不在 Edge Canon 规范的范围内。*
