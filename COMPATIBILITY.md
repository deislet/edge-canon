# Node.js Compatibility Strategy

> **Core Philosophy**: Keep the runtime pure (Web Standards only) while leveraging the compiler to bridge the ecosystem gap.
>
> [中文版](./COMPATIBILITY.zh.md)


This document outlines the strategy for handling Node.js ecosystem compatibility in the Denix runtime environment without compromising its "Write Once, Run Anywhere" principle.

---

## 1. The Challenge

Modern edge runtimes (Cloudflare Workers, Deno Deploy, Denix) are built on **Web Standards** (Fetch, WebCrypto, Streams), not Node.js APIs. However, the vast npm ecosystem heavily relies on Node.js-specific modules (`buffer`, `util`, `events`, `process`).

**Strict Policy**: The Edge Canon intentionally **DOES NOT** implement Node.js APIs to ensure portability and security.

## 2. Compatibility Strategies

We employ a three-tiered non-intrusive strategy to support the ecosystem:

### Strategy A: Build-Time Polyfill (Recommended)

Leverage the `deforge` compiler to automatically inject pure JavaScript implementations of Node.js core modules during the build process.

*   **Mechanism**:
    *   When the compiler encounters `import { Buffer } from 'buffer'`, it rewrites it to use a user-land polyfill (e.g., `npm:buffer`).
    *   Global objects like `process.env` are statically replaced with defined environment variables or `import.meta.env`.
*   **Pros**:
    *   **Runtime Purity**: No "dirty" Node compatibility layer in the runtime itself.
    *   **Broad Compatibility**: Fixes ~90% of legacy packages (e.g., `jsonwebtoken`, old `uuid`).
*   **Cons**:
    *   **Bundle Size**: Polyfills add weight to the final artifact.

### Strategy B: WinterCG / Modern Ecosystem (Best Practice)

Encourage and guide developers towards "Winter-compatible" libraries that natively support Edge Runtimes.

*   **Mechanism**:
    *   The CLI (`denictl`) and Linter identify legacy heavy libraries and suggest modern alternatives.
*   **Replacement Guide**:
    *   `jsonwebtoken` (Buffer heavy) → **`jose`** (WebCrypto native)
    *   `express` (Node http) → **`hono`** (Standard Req/Res)
    *   `pg` (net socket) → **`postgres.js`** (Edge compatible) or Platform DB Service
*   **Pros**:
    *   **Zero Overhead**: No polyfills, maximum performance.
    *   **Future Proof**: Aligned with WinterCG standards.

### Strategy C: WebAssembly / Wasm (Native Performance)

For computationally intensive or system-level tasks that cannot be polyfilled (e.g., image processing, heavy crypto).

*   **Mechanism**:
    *   Compile C++/Rust/Go code to `.wasm` modules.
    *   Import via standard ESM: `import mod from './lib.wasm'`.
*   **Use Cases**:
    *   Image resizing (`sharp` replacement)
    *   PDF generation
    *   Complex algorithms
*   **Pros**:
    *   **True Portability**: Runs identical byte-code everywhere.
    *   **Performance**: Near-native speed.

---

## 3. Implementation Plan

### For `deforge` (Compiler)
*   [ ] Enable **Auto-Polyfill** by default for: `buffer`, `events`, `util`, `path`, `url`, `string_decoder`.
*   [ ] Fail hard on un-polyfillable modules: `fs`, `net`, `child_process`, `cluster`, `dgram`.

### For `denictl` (CLI)
*   [ ] Add **"Ecosystem Audit"**: Scan `package.json` and warn about non-edge-friendly dependencies.
    *   *Example*: "Warning: `express` detected. This library increases bundle size significantly. Consider using `hono` for Edge."

### For `edge-canon` (Standard)
*   [ ] Maintain strict adherence to Web Standards.
*   [ ] Explicitly support `.wasm` imports (Completed in v1.1).
