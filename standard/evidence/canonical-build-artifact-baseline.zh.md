# Canonical Build Artifact 行业证据基线

- 能力族：`canonical-build-artifact`
- 记录日期：2026-09-04
- 用途：解释候选条款的行业来源；本文件本身不具规范效力

## 1. 参考实现的共同方向

| 主题 | Vercel Build Output API | Tencent EdgeOne Pages Build Output Configuration | Edge Canon 取值 |
| --- | --- | --- | --- |
| 输出形态 | 文件系统目录 `.vercel/output` | 文件系统目录 `.edgeone/output` | 文件系统目录；传输压缩格式不属于规范 |
| 格式演进 | `config.json` 中使用版本号，当前文档为 v3 | `config.json` 中使用版本号，当前文档为 v3 | 独立的 `edge-canon.build-output/v1`，未知更高 major 必须拒绝 |
| 静态与函数产物 | `static`、`functions` 与路由配置 | `static`、`functions` 与路由配置 | 由语义文档索引表达；各能力族分别定义内容 |
| 供应商派生 | 输出由框架或构建器产生，再交给平台部署 | 输出可由框架适配器产生，再交给平台部署 | source/framework adapter → 唯一 canonical output → provider packager/driver |

两家产品均证明“版本化输出目录”是可落地的行业接口。它们的具体目录名、函数封装和路由字段仍是供应商契约，不能直接成为统一标准。Edge Canon 只取共同结构，并增加跨平台可验证的文件摘要、构建输入摘要和证明索引。

## 2. 供应链证据

- [SLSA v1.2 Provenance](https://slsa.dev/spec/v1.2/provenance)要求 provenance 能回答产物由谁、如何、从哪些输入生成，并用输出摘要关联产物；Edge Canon 将 provenance 作为被内容清单绑定的语义文档。
- [SLSA v1.2 Build requirements](https://slsa.dev/spec/v1.2/build-requirements)区分可用 provenance、托管构建平台和更高等级的隔离保证；当前 Draft 只要求可验证引用，不宣称达到某个 SLSA build level。
- [SPDX 2.3](https://spdx.github.io/spdx-spec/v2.3/)提供行业通用 SBOM 数据模型；当前 Draft 要求 SBOM 文档索引，但具体 SPDX profile 与后续 CycloneDX 互操作仍待供应链能力条款细化。
- [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)给出 JSON 的确定性序列化方法；Edge Canon 清单使用 JCS 字节作为清单身份输入。

## 3. 已冻结边界

1. canonical output 是目录契约，不规定 zip、tar、OCI 或对象存储封装；这些是可替换的传输层。
2. `.edge-canon/output.json` 是唯一根清单，且不把自身列入文件集合，避免自引用摘要。
3. canonical artifact identity 是根清单 JCS 字节的 SHA-256；清单通过文件集合根摘要传递绑定全部内容。
4. 文件集合根摘要按 UTF-8 路径字节序排序，逐项输入 `u64be(pathByteLength) || pathUtf8 || u64be(fileSize) || sha256Bytes` 后计算 SHA-256。
5. 路由、函数、资源绑定、SBOM、provenance 和验证报告通过带版本的语义文档索引演进；本能力族不提前定义其他能力族的内部字段。
6. canonical output 不包含供应商部署 ID、账户 ID、地域选择、原生 binding 或运行时 secret value。供应商 driver 只在派生产物和控制面状态中加入这些数据。
7. 发布签名签 canonical artifact identity，签名封装不进入被签清单，避免循环依赖；签名格式在后续供应链契约中冻结。

## 4. 尚未冻结、继续阻断晋级的事项

1. 可移植实现必须支持的最小文件数、单文件大小和总产物大小尚无两家参考产品共同公开保证，因此 `minimum-resource-guarantees` 保持 `pending`。
2. `runtime-entrypoints`、`routes`、`assets`、`bindings` 等语义文档的 schema 由对应能力族定义；当前只冻结索引与完整性关系。
3. SPDX/CycloneDX 的标准必选字段、SLSA predicate/profile、签名封装和信任根分发尚未完成。
4. 文件名使用 Unicode NFC 并拒绝大小写折叠冲突；完整 Unicode case folding 的算法版本仍需在进入 normative-complete 前固定。
5. 当前 fixture 验证参考构建器的跨操作系统确定性；真实框架适配器与三个一等后端的派生验证仍未完成。

2026-09-04 的 Linux、macOS 与 Windows 同源执行结果保存在[`canonical-build-artifact-platforms-2026-09-04.json`](../../conformance/evidence/canonical-build-artifact-platforms-2026-09-04.json)。三套环境均通过八个 Draft case，并生成同一 artifact identity；该记录只证明 reference harness 的可移植性，不是 provider 合规证据。

## 5. 官方资料

- [Vercel Build Output API](https://vercel.com/docs/build-output-api)
- [Vercel Build Output Configuration](https://vercel.com/docs/build-output-api/configuration)
- [Vercel Build Output Primitives](https://vercel.com/docs/build-output-api/primitives)
- [Tencent EdgeOne Pages Build Output Configuration](https://pages.edgeone.ai/document/building-output-configuration)
- [SLSA v1.2 Specification](https://slsa.dev/spec/v1.2/)
- [SPDX 2.3 Specification](https://spdx.github.io/spdx-spec/v2.3/)
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)
