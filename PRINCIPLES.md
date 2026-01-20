# Edge Canon Principles & Design Philosophy

> The architectural foundation of the Edge Canon specification.
> 
> [中文版](./PRINCIPLES.zh.md)

## 1. Core Philosophy

**Edge Canon** is built on a single, uncompromising promise: **"Write Once, Run Anywhere."**

To achieve this in a fragmented edge computing landscape (Cloudflare, Deno, Tencent, etc.), we adhere to three foundational principles:

### 1.1 The "Least Common Denominator" Strategy
The specification only exposes features that can be reliably implemented across *all* major edge platforms.
*   **Yes**: `fetch`, `Request/Response`, `ReadableStream`, `crypto.subtle`.
*   **No**: `fs.readFileSync` (Node.js specific), `eval` (security risk), platform-specific proprietary APIs.

### 1.2 Zero Platform Leakage
The code you write must never know *where* it is running.
*   **Forbidden**: `if (typeof Cloudflare !== 'undefined')`
*   **Forbidden**: Conditional imports based on environment.
*   **Enforced**: The compiler (`deforge`) actively scans for and rejects platform-specific global objects.

### 1.3 Capability Negotiation (Compile-Time)
Instead of runtime feature detection ("Can I use a database?"), we use **compile-time negotiation**.
*   Developers declare required services (KV, DB, Queue) in `.config.json`.
*   The compiler verifies if the target platform supports these services.
*   If a platform cannot satisfy the contract, the build fails immediately.

---

## 2. The Abstract Resource Model

Edge Canon defines an abstract resource model that decouples application logic from infrastructure.

### 2.1 The Context Object
Everything an application needs is injected via the `Context` object. This is the **only** bridge to the outside world.

```typescript
// The "World" as seen by an Edge Canon function
interface Context {
  // Input
  request: Request;
  env: Record<string, string>;
  
  // Resources
  services: {
    kv?: KVStore;      // Abstract Key-Value
    database?: Database; // Abstract SQL
    blob?: BlobStore;  // Abstract Object Storage
    queue?: Queue;     // Abstract Message Queue
  };
  
  // Output/Side-effects
  log: Logger;
  waitUntil(promise: Promise<any>): void;
}
```

### 2.2 Service Binding
*   **Code View**: `context.services.kv.get('key')`
*   **Cloudflare Implementation**: Maps to `env.NAMESPACE.get('key')`
*   **Deno Implementation**: Maps to `Deno.openKv().get(['key'])`
*   **Deislet Implementation**: Maps to gRPC/Syscall to the host process.

This indirection allows the underlying implementation to change without affecting application code.

---

## 3. Isolation & Security Model

While `Edge Canon` does not mandate a specific isolation technology (Isolate vs Container), it assumes a **Shared-Nothing Architecture**.

### 3.1 State Management
*   **Stateless Compute**: Handlers are ephemeral. Global variables are not guaranteed to persist between requests.
*   **External State**: All state must be stored in attached services (KV, DB).

### 3.2 Security Boundaries
*   **No File System Access**: Functions cannot read/write arbitrary files (use Blob Store).
*   **No Socket Access**: Raw TCP/UDP sockets are generally restricted (use `fetch` or Database drivers).
*   **No Process Spawning**: `child_process` is forbidden.

---

## 4. Ecosystem Compatibility

### 4.1 The Node.js Problem
The vast majority of JavaScript libraries assume a Node.js environment. Edge Canon addresses this via a **Compiler-Driven Polyfill Strategy**.

*   **Standard Library**: We do *not* implement Node.js APIs in the runtime.
*   **Polyfilling**: The compiler (`deforge`) injects user-space implementations for safe APIs (`path`, `url`, `events`, `buffer`) at build time.
*   **Rejection**: Unsafe APIs (`fs`, `net`, `child_process`) are rejected.

### 4.2 Web Assembly (Wasm)
Wasm is treated as a first-class citizen for portable, high-performance compute tasks (image processing, compression, cryptography) that exceed JavaScript's capability.

---

## 5. Reference Implementation: Deislet

**Deislet** serves as the reference implementation (Proof of Concept) for Edge Canon. It proves that the specification is implementable on a self-hosted stack.

*   **Role**: To validate the spec and provide a "local" target for testing.
*   **Compliance**: Deislet achieves 100% compliance by mapping `Edge Canon` interfaces to Rust-based backend services.

| Canon Interface | Deislet Implementation |
|:---|:---|
| `Context` | `denix` (V8 Runtime wrapper) |
| `KVStore` | `denira` (SQLite-backed KV) |
| `Routing` | `deflux` (Pingora-based LB) |

*Note: Deislet's internal architecture (Load Balancer, Supervisor, etc.) is outside the scope of the Edge Canon specification.*
