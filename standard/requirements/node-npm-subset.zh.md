# Node/npm 版本化子集候选要求

- 标准：`edge-canon.next`
- 能力族：`node-npm-subset`
- 状态：Draft Candidate
- 规范效力：无；仅在 Proposal 0001 晋级并发布后生效
- Node 语义基线：`24.20.0`
- 最后核对参考实现：2026-09-04

本草案把 Node/npm 定义为统一 Edge Canon 标准的一部分，而不是 provider profile。应用仍导出标准 Fetch/Context handler；packager 可以为 Cloudflare 选择 Workers 原生实现，为 EdgeOne 选择 Node Function，为 Deislet/Deno 选择兼容层，但不能要求应用按供应商分支。完整 export 清单与构建策略由 [`node-npm-subset.schema.json`](../../schemas/node-npm-subset.schema.json) 固定，行业事实记录在[证据基线](../evidence/node-npm-subset-baseline.zh.md)。

模块名相同不代表功能相同。Cloudflare 的 import-only stub 或 noop、仅能成功 import 但调用失败的 polyfill、以及宿主偶然存在的 Node API，都不算支持。标准 export 必须具备本文件规定的可观察语义；不在清单内的 builtin/export 必须在部署前失败。

## 1. API

- **EC-NODE-API-001**：Node 语义以 Node.js `24.20.0` 官方文档和上游测试为首要真源；仅包含 capability lock `builtinModules` 中逐项列出的 module/export，不因宿主升级自动扩张。
- **EC-NODE-API-002**：支持 `node:assert`、`node:assert/strict`、`node:async_hooks`、`node:buffer`、`node:crypto`、`node:diagnostics_channel`、`node:events`、`node:path`、受限 `node:process`、`node:querystring`、`node:stream`、`node:stream/promises`、`node:string_decoder`、`node:timers`、`node:timers/promises`、`node:url`、`node:util` 与 `node:zlib` 的锁定 exports；class/object 的选中操作服从 Node 24.20.0 语义。
- **EC-NODE-API-003**：应用和依赖可以使用 `Buffer`、`process`、`setImmediate`、`clearImmediate` globals；packager 必须在缺少原生 global 的后端注入同语义实现。`process.version` 固定为 `v24.20.0`、`process.versions.node` 固定为 `24.20.0`、`process.platform` 固定为 `linux`，避免部署后端身份进入应用逻辑。与该平台身份一致，`node:path` 的顶层操作固定为 POSIX 分支，相对 `resolve` 从虚拟根 `/` 开始；显式 `path.posix` 和 `path.win32` 分支仍可用，二者的相对 `resolve` 分别从虚拟根 `/` 和 `\\` 开始，不读取宿主 cwd。`node:url` 的 `pathToFileURL` 默认也从虚拟根 `/` 解析，`fileURLToPath` 默认采用 POSIX 分支；调用方显式传入 `{ windows: true }` 时才采用固定 Windows 路径语义。`process.getBuiltinModule(name)` 对规范/裸拼写的已选中模块返回只含 capability lock 所列导出的模块对象，对清单外名称或非字符串返回 `undefined`；它不能返回供应商扩展或用模块名字符串代替模块对象。
- **EC-NODE-API-004**：`node:` 是 builtin 的规范 specifier；与清单中 builtin 同名的 bare specifier 可以在构建时规范化成 `node:`，npm package 不得遮蔽 builtin。最终部署 artifact 是只含静态依赖图的 ESM；CommonJS、`.cjs`、`require()` 与 `module.exports` 必须在构建时解析并转换，运行时不提供通用 `require`。
- **EC-NODE-API-005**：构建器读取 root 与依赖 package 的 `name`、`version`、`type`、`dependencies`、`optionalDependencies`、`peerDependencies`、`exports`、`imports`。ESM 激活的条件集合以规范数组 `edge-canon, worker, browser, import, default` 编码，CommonJS 以 `require` 替换 `import`；数组顺序用于 capability lock 的规范身份，不覆盖 Node 24.20.0 的 package 对象语义。解析 `exports`/`imports` 条件对象时按 package 中的 key 声明顺序检查，较早的已激活条件优先，`default` 应最后声明。
- **EC-NODE-API-006**：registry package 必须由 `package-lock.json` lockfileVersion 3 锁定准确版本、resolved source 与 sha512 integrity；公共和认证私有 npm registry 只在受控构建阶段访问。运行时不得安装、解析或下载 package。

## 2. 错误

- **EC-NODE-ERR-001**：不在清单内的 builtin 以 `EC_NODE_BUILTIN_UNSUPPORTED`、清单外 export 以 `EC_NODE_EXPORT_UNSUPPORTED` 在执行应用前失败；成功 import 的 stub/noop 不得替代失败。
- **EC-NODE-ERR-002**：缺失 lock、lockfileVersion 非 3、manifest/lock 不一致或 unresolved package 分别以 `EC_NPM_LOCK_REQUIRED`、`EC_NPM_LOCK_VERSION_UNSUPPORTED`、`EC_NPM_LOCK_MISMATCH` 或 `EC_NPM_PACKAGE_UNRESOLVED` 失败。
- **EC-NODE-ERR-003**：registry package 缺失 sha512 integrity 或下载字节不匹配时，以 `EC_NPM_INTEGRITY_REQUIRED` 或 `EC_NPM_INTEGRITY_FAILED` 失败；不得回退到浮动 tag、缓存中其他版本或未校验 mirror。
- **EC-NODE-ERR-004**：依赖声明 `preinstall`、`install`、`postinstall` hook、包含 `.node` 文件或需要 node-gyp/native addon 时，分别以 `EC_NPM_LIFECYCLE_SCRIPT_UNSUPPORTED` 或 `EC_NPM_NATIVE_ADDON_UNSUPPORTED` 在构建阶段失败。
- **EC-NODE-ERR-005**：无法静态枚举的 `require(expr)`、dynamic import specifier 或运行时 package 查找以 `EC_NPM_DYNAMIC_RESOLUTION_UNSUPPORTED` 失败；错误必须包含来源模块和源码位置，但不得包含 registry credential。

## 3. 并发、一致性与顺序

- **EC-NODE-CON-001**：`process.nextTick`、Promise job、timer 与 `setImmediate` 服从 Node 24.20.0 在同一 invocation 内的相对顺序；实现不得用 Web timer 的返回类型或队列顺序冒充 Node timer。
- **EC-NODE-CON-002**：`AsyncLocalStorage.run/getStore/exit` 的选中语义必须跨 Promise、nextTick、timer 与 EventEmitter listener 传播；`exit` 回调暂时离开当前 store，返回后恢复原 store；`run` 返回后 store 不再可见；并发 invocation 的 store 不得互相可见。Cloudflare Workers 明确不实现 `enterWith/disable`，因此二者不属于统一应用标准；实现不得假装它们已获得跨后端保证。
- **EC-NODE-CON-003**：同一 manifest、lock、package bytes、capability lock 和构建选项必须产生字节相同的 module graph 与 ESM artifact；安装缓存命中、下载顺序和并发度不得改变选择的版本、条件分支或输出顺序。
- **EC-NODE-CON-004**：Node stream `pipeline`/`finished`、EventEmitter listener 顺序、StringDecoder 多字节边界、zlib byte output 与 crypto digest 必须保持 Node 24.20.0 的正常、错误和结算顺序。

## 4. 生命周期

- **EC-NODE-LIFE-001**：所有 package resolution、CommonJS 转换、builtin 校验、integrity 校验与 ESM link 在发布事务开始前完成；handler 启动后不得补装或修改依赖图。
- **EC-NODE-LIFE-002**：Node timer、stream、AsyncLocalStorage context 和 diagnostics subscription 绑定到创建它们的 invocation/部署；invocation 结束时平台必须取消不可继续的句柄并释放 context，不能使它们保持宿主进程存活。
- **EC-NODE-LIFE-003**：root package scripts 永不由标准 build 隐式执行；依赖 install hooks 不执行且阻断构建。需要代码生成的应用必须把生成结果作为显式、可审计的标准 build 输入。

## 5. 最低资源保证

- **EC-NODE-LIMIT-001**：实现必须能解析并打包至少 16 个 registry package、安装后普通文件总量至少 1,048,576 octet 的无环静态图；每个 package 都必须通过 lock 与 integrity 校验。该下限需要三个真实后端验证后才能冻结。
- **EC-NODE-LIMIT-002**：本版本不保证更大的 package 数、artifact size、单文件大小、registry 并发、构建时长或解压倍率；实现自身限制必须在构建前可查询并在超限时确定失败，不能在运行时丢模块。

## 6. 安全与隔离

- **EC-NODE-SEC-001**：registry token、basic auth、私有 URL credential 和 npm 配置 secret 只能进入受控 fetch；不得写入 artifact、source map、cache key、错误、日志或 provenance。发布 provenance 只记录无 credential 的 registry origin、package identity 与 integrity。
- **EC-NODE-SEC-002**：构建必须拒绝 absolute/traversal package path、逃出 package root 的 exports/imports target、symlink/hardlink 逃逸、case/Unicode 冲突、archive bomb 和特殊设备文件；package 不得读取其他 tenant 的工作区或缓存。
- **EC-NODE-SEC-003**：`process.env` 是当前 invocation 的受控快照；写入只影响当前快照，不修改宿主或其他 invocation。宿主 PID、argv、cwd、用户、网络接口、CPU 拓扑和真实平台版本不属于 Node v1 应用面。
- **EC-NODE-SEC-004**：`child_process`、`cluster`、`worker_threads`、FFI/native addon、任意宿主文件系统、任意端口监听以及 import-only stub 初始排除；provider 内部可用这些机制实现标准，但不能把句柄或探测面暴露给应用。

## 7. 失败与恢复

- **EC-NODE-FAIL-001**：package 下载可在发布前按有界策略重试，但每次必须使用同一 locked source 和 integrity；解析、转换或校验失败不得提交部分 artifact、改变现行 deployment 或污染已验证 cache entry。
- **EC-NODE-FAIL-002**：构建缓存项必须由 package identity、integrity、Node subset version、conditions、transformer version 和构建策略共同寻址；校验失败、进程崩溃或取消产生的临时项不能作为命中。
- **EC-NODE-FAIL-003**：运行时发现缺失 module/export 是构建器或部署损坏，必须产生标准非泄漏 500 与可观测错误 `EC_NODE_ARTIFACT_INCOMPLETE`；不得联网修复、转向宿主全局包或继续运行另一版本。
- **EC-NODE-FAIL-004**：Node API 抛错、stream error、timer callback error 与 AsyncLocalStorage callback error 保留 Node 的错误类型/code/cause；平台边界负责净化客户端响应，但不能把失败改为成功、noop 或正常 EOF。

## 8. 升级与迁移

- **EC-NODE-UPG-001**：capability lock 必须包含精确 Edge Canon commit、Node `24.20.0` 基线、完整 module/export 清单、module/npm policy 与 limits；浮动 Node major、未知字段或 provider 扩张必须在执行前拒绝。
- **EC-NODE-UPG-002**：Cloudflare、EdgeOne 与 Deislet packager 必须从同一 lock 派生实现选择和 source validator；Cloudflare compatibility date、EdgeOne Node runtime、Deno reported Node version或宿主 binary 更新不得自动改变应用可观察面。
- **EC-NODE-UPG-003**：新增 export、升级 Node baseline、改变条件优先级/lockfile 格式或纳入 fs/http/net/tls/os/module/native addon 必须发布新标准版本、扩充 oracle 并提供迁移诊断；旧版本仍可重建和回滚。

## 9. 晋级条件

进入 `normative-complete` 前仍需：

1. 从 Node 24.20.0 上游测试中建立逐 export 覆盖映射，并在 Cloudflare、EdgeOne Node Functions 与 Deislet 运行全部 EC-NODE cases；
2. 实现真实 npm registry、私有 registry、package-lock v3、条件 exports/imports、CommonJS 转换、integrity、缓存和 secret redaction 端到端测试；
3. 在三个一等后端验证 16 package/1 MiB 正向下限，并统一超限错误；
4. 审计 Cloudflare native/partial/stub 差异、EdgeOne Node runtime 固定方式与 Deislet compatibility layer，证明缺失符号不会降级为 noop；
5. 建立标准升级时的 package 重建、双版本运行与 rollback 证据；
6. 与 `environment-secrets`、`streams-websockets-background-work`、`canonical-build-artifact` 的重叠规则完成交叉一致性审查。
