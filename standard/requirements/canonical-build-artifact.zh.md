# Canonical Build Artifact 候选要求

- 标准：`edge-canon.next`
- 能力族：`canonical-build-artifact`
- 状态：Draft Candidate
- 规范效力：无；仅在 Proposal 0001 晋级并发布后生效
- 最后核对参考实现：2026-09-04

本草案定义 source/framework adapter 与 provider packager/driver 之间唯一、可验证的 canonical Build Output。应用面向 Edge Canon 标准，构建器先生成这一产物；Cloudflare、EdgeOne、Deislet 等后端只能从它派生供应商产物，不能把各自构建格式暴露成应用 profile。

## 1. 规范对象

canonical Build Output 是一个完成态目录。根清单位于 `.edge-canon/output.json`，必须符合 [`canonical-build-output.schema.json`](../../schemas/canonical-build-output.schema.json)，并以 RFC 8785 JCS 字节加一个 LF 写入。根清单本身不列入 `content.files`。

canonical artifact identity 为根清单规范字节的 SHA-256。文件集合根摘要使用 `edge-canon.file-set-sha256/v1`：按 UTF-8 路径字节升序排列文件；每个条目依次输入 `u64be(pathByteLength)`、路径 UTF-8 字节、`u64be(fileSize)` 和 32 字节 SHA-256；最后对全部条目串联值计算 SHA-256。所有整数都是无符号 64 位大端值。

`documents` 索引至少包含且各包含一个 `runtime-entrypoints`、`sbom`、`provenance` 和 `validation-report` 文档。索引只冻结文档的 kind、schema major、路径与摘要；内容 schema 由相应能力族或供应链契约定义。

## 2. API

- **EC-ARTIFACT-API-001**：构建器必须生成一个目录形态的 canonical Build Output，完成态目录必须包含且只能包含一个根清单 `.edge-canon/output.json`；供应商 packager 和 deployment driver 必须只从该完成态目录读取输入。
- **EC-ARTIFACT-API-002**：根清单必须使用 `edge-canon.build-output/v1`，以 JCS 规范字节写入，并锁定 `edge-canon.next@<40-lowercase-hex-commit>` 形式的精确标准版本；canonical artifact identity 必须等于根清单规范字节的 SHA-256。
- **EC-ARTIFACT-API-003**：`content.files` 必须按 UTF-8 路径字节序严格升序列出除根清单以外的每个普通文件且恰好一次，并记录准确 size、SHA-256 和 media type；`content.rootSha256` 必须按本文件定义的 v1 文件集合算法计算。
- **EC-ARTIFACT-API-004**：`documents` 中每项必须引用 `content.files` 内同一路径和同一摘要；完成态产物至少索引 `runtime-entrypoints`、`sbom`、`provenance` 与 `validation-report` 四种文档，且同一 kind/path 组合不得重复。
- **EC-ARTIFACT-API-005**：从 `runtime-entrypoints` 可达的每条运行时 module edge 必须在构建期闭包为 `content.files` 中的相对模块路径，或另一能力锁逐项选中的标准 runtime module specifier。bare package 与 `npm:`、`jsr:`、`http:`、`https:`、`data:`、`file:` 等外部解析形式可以作为受控构建输入，但不得残留在完成态 module graph；provider packager、部署端和运行时不得联网解析、读取宿主文件或转向供应商 package resolver 补全它们。

## 3. 错误

- **EC-ARTIFACT-ERR-001**：验证失败必须产生稳定的 `EC_ARTIFACT_*` 失败代码和不含文件内容、secret value 或主机绝对路径的说明；不得把异常、JSON parser stack 或操作系统错误直接作为标准错误输出。
- **EC-ARTIFACT-ERR-002**：清单非规范、字段未知、文件缺失、存在未列文件、摘要/大小不符、文档引用不符或文件类型不允许时，验证必须失败；实现不得修补、忽略或按供应商默认值解释后继续派生部署产物。
- **EC-ARTIFACT-ERR-003**：module graph 中残留外部/bare edge 必须以 `EC_ARTIFACT_MODULE_EXTERNAL` 失败，指向缺失或越出产物的相对 edge 必须以 `EC_ARTIFACT_MODULE_MISSING` 失败；两者都必须发生在完成态发布和 provider 派生前，且错误不得回显 URL credential、registry token 或宿主绝对路径。

## 4. 并发、一致性与顺序

- **EC-ARTIFACT-CON-001**：精确标准版本、源树、构建计划、依赖锁、公开输入、source date epoch 和工具链摘要全部相同时，构建器必须产生字节相同的根清单、文件集合根摘要及语义文件；主机操作系统、目录位置、遍历顺序和 wall-clock time 不得改变结果。
- **EC-ARTIFACT-CON-002**：并发构建必须使用隔离的 staging 目录，并通过同一文件系统内的原子发布形成完成态目录；两个构建的文件、清单或临时状态不得混入彼此的产物。

## 5. 生命周期

- **EC-ARTIFACT-LIFE-001**：只有根清单及其全部文件已经落盘、验证通过并由 staging 原子发布后的目录才是完成态 canonical Build Output；staging、部分写入目录和验证失败目录没有 artifact identity，且不得进入缓存、签名、派生或部署流程。

## 6. 最低资源保证（Pending）

当前没有足够的两家参考产品共同公开保证来冻结最小文件数、单文件大小或总产物大小。本维度保持 `pending`；实现自身限制必须在构建前可发现，但不得被表述为可移植标准保证。

## 7. 安全与隔离

- **EC-ARTIFACT-SEC-001**：所有路径必须是 `/` 分隔的 NFC UTF-8 相对路径，不得含空段、`.`、`..`、反斜杠、控制字符、Windows 保留设备名、冒号或尾随点/空格；大小写不敏感比较发生冲突的两个路径必须拒绝。产物只允许普通文件和目录，符号链接、硬链接别名、junction、socket、device 与其他特殊节点必须拒绝。
- **EC-ARTIFACT-SEC-002**：根清单和标准语义文档不得包含供应商账户/项目/部署/地域 ID、供应商原生 binding 或运行时配置值；这些信息只能出现在 canonical output 之外的 provider derived artifact 或控制面状态中。
- **EC-ARTIFACT-SEC-003**：构建 secret 可以作为受控构建输入，但其值不得出现在根清单、路径、文件内容、SBOM、provenance、验证报告、日志或错误说明中；运行时 secret value 和环境值不得成为 canonical output 的构建输入。

## 8. 失败与恢复

- **EC-ARTIFACT-FAIL-001**：构建进程失败、被取消、主机重启或验证未通过时，不得留下可被识别为完成态的新产物；重试必须从新的隔离 staging 开始，旧 staging 只能作为垃圾回收对象。
- **EC-ARTIFACT-FAIL-002**：缓存命中、下载、复制、签名前、provider 派生前和部署前必须重新验证根清单规范字节、全部文件及文件集合根摘要；任一步发现不一致都必须 fail closed，不能依赖存储层校验替代标准验证。

## 9. 升级与迁移

- **EC-ARTIFACT-UPG-001**：实现只可接受其明确支持的 artifact format major 和精确标准版本；未知更高 major、浮动标签、分支名、缩写 commit 或缺少版本必须在读取语义文档前拒绝。
- **EC-ARTIFACT-UPG-002**：已发布的 artifact format major 和标准版本不可原地改变。新字段或新语义必须通过兼容 schema 演进或新 major 发布；迁移器必须以旧产物为只读输入，生成具有新 identity 的新产物并保留 provenance lineage。

## 10. 未决项与晋级条件

本能力族进入 `normative-complete` 前至少还需：

1. 冻结最小资源保证和完整 Unicode case-folding 算法版本；
2. 由对应能力族发布四类必选语义文档及 routes/assets/bindings 等可选文档 schema；
3. 冻结 SBOM、provenance、validation report 和签名封装的必选字段；
4. 对真实框架 adapter 运行 Linux、macOS、Windows 确定性验证；
5. 在 Cloudflare、EdgeOne 与 Deislet provider packager 上证明只能从已验证 canonical output 派生，且篡改必然 fail closed。
