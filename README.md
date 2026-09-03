# Edge Canon

> The authoritative specification for universal edge functions.
>
> [中文版](./README.zh.md)


**Edge Canon** is the unified standard for writing edge functions that run everywhere—Cloudflare, Deno, Tencent, **Deislet**, and beyond.

> **Evolution notice:** v0.1 remains the description of the existing implementation.
> The next standard is being defined as one capability set, without Basic/Extended
> profiles, in [Proposal 0001](proposals/0001-unified-platform-contract/README.zh.md).
> Its machine-readable [contract](standard/contract.json) and
> [conformance registry](conformance/registry.json) are proposals, not a released
> compatibility claim.

## Documentation

* 📜 **[SPECIFICATION](SPECIFICATION.md)**  
  The Core Specification. This document defines the project structure, handler interfaces, and standard services (KV, DB, etc.).

* 🧠 **[PRINCIPLES](PRINCIPLES.md)**  
  The Design Philosophy. Explains the architectural decisions and the "Why" behind the "What".

* 🔄 **[COMPATIBILITY](COMPATIBILITY.md)**  
  Compatibility Guides. Detailed analysis of Node.js compatibility and migration paths.

* 📐 **[schemas](./schemas)**  
  Machine-readable definitions (JSON Schema) for validation.

* 🧪 **[fixtures](./fixtures)**  
  Standard code examples and compliance tests to verify implementations.

---

*"Write Once, Run Anywhere."*
