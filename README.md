# Edge Function Specification v1.0

> 统一边缘函数部署标准规范  
> 支持多平台兼容发布（Cloudflare Workers/Pages、Deno Deploy、Tencent EdgeOne）  
> **核心原则**：一次编写，随处部署；禁止平台特定代码

---

## 1. 项目结构规范

### 1.1 目录结构

```
my-edge-app/
├── functions/                    # 核心函数目录（必需）
│   ├── index.ts                  # 入口点（默认路由）
│   ├── hello.ts                  # 路由：/hello
│   ├── api/
│   │   ├── index.ts              # 路由：/api
│   │   ├── users.ts              # 路由：/api/users
│   │   ├── posts/
│   │   │   ├── index.ts          # 路由：/api/posts
│   │   │   └── [id].ts           # 路由：/api/posts/:id (动态参数)
│   │   └── [[catch]].ts          # 路由：/api/* (catch-all)
│   └── middleware.ts             # 全局中间件（可选）
├── .config.json                  # 通用配置文件（必需）
├── .env                          # 本地环境变量（开发用）
├── .env.production               # 生产环境变量（部署用）
├── package.json                  # 项目元数据（可选）
└── README.md                     # 项目说明文档
```

### 1.2 配置文件标准（.config.json）

```json
{
  "version": "1.0",
  "name": "my-edge-app",
  "description": "Edge Function Project",
  "runtime": "standard-v1",
  "language": "typescript",
  "entryPoint": "functions/index.ts",
  
  "functionRoot": "./functions",
  
  "routing": {
    "caseSensitive": false,
    "dynamicParamPattern": "[param]",
    "catchAllPattern": "[[catchall]]"
  },
  
  "environment": {
    "variables": {
      "LOG_LEVEL": "info",
      "API_TIMEOUT": "30000"
    },
    "secrets": [
      "DATABASE_URL",
      "API_KEY",
      "JWT_SECRET"
    ]
  },
  
  "services": {
    "kv": {
      "enabled": true,
      "binding": "KV_STORE"
    },
    "database": {
      "enabled": true,
      "binding": "DB"
    },
    "cache": {
      "enabled": true,
      "binding": "CACHE"
    }
  },
  
  "build": {
    "outDir": "./dist",
    "minify": true,
    "sourceMap": false
  },
  
  "vendors": {
    "cloudflare": {
      "enabled": true
    },
    "deno": {
      "enabled": true
    },
    "tencent": {
      "enabled": true
    }
  },
  
  "limits": {
    "maxExecutionTime": 30000,
    "maxPayloadSize": 52428800,
    "maxConcurrency": 1000
  }
}
```

**说明**：
- `.config.json` 是纯源码配置，不包含任何平台特定的参数（如 Cloudflare account、Deno org 等）
- 平台特定的部署配置（account ID、zone、organization 等）通过 CLI 参数或 CLI 配置文件管理，不混入源码

---

## 2. 核心原则

### 2.1 强制要求

1. **禁止平台特定代码**
   - 不允许检测平台类型（如 `if (isCloudflare)`）
   - 不允许条件导入平台特定模块
   - 不允许访问平台原生 API（无 `raw` 或 `env` 的直接访问）
   
2. **代码完全通用**
   - 开发者只能使用规范定义的统一接口
   - 编译器负责将统一接口转换为平台实现
   
3. **编译时能力协商**
   - 如果某个平台不支持某个功能，编译时报错
   - 开发者在 `.config.json` 中声明需要的能力，编译器检查兼容性

### 2.2 违规示例（禁止）

```typescript
// ❌ 禁止：检测平台
if (typeof Deno !== 'undefined') {
  // Deno 特定代码
}

// ❌ 禁止：条件导入
const kv = import(isCloudflare ? '@cloudflare/kv' : '@deno/kv');

// ❌ 禁止：直接访问平台 API
const cfKV = env.MY_KV_NAMESPACE;  // 不允许
const denoKV = await Deno.openKv(); // 不允许

// ❌ 禁止：平台判断后使用不同代码
export default async function(context: Context) {
  if (context.raw?.cloudflare) {
    // Cloudflare 特定逻辑
  } else if (context.raw?.deno) {
    // Deno 特定逻辑
  }
}
```

### 2.3 正确做法（推荐）

```typescript
// ✅ 只使用统一接口
export default async function handler(context: Context): Promise<Response> {
  const kv = context.services.kv;
  const value = await kv.get('mykey');
  return new Response(value || 'not found');
}

// ✅ 代码完全一致，不需要任何平台判断
```

---

## 3. Handler 函数标准

### 3.1 通用 Handler 接口

所有函数必须导出一个标准的 HTTP Handler，支持以下两种形式：

#### 方式一：默认导出（推荐）

```typescript
export default async function handler(
  context: Context
): Promise<Response> {
  return new Response('Hello World', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' }
  });
}
```

#### 方式二：具体方法导出（可选支持）

```typescript
export async function onRequest(context: Context): Promise<Response> {
  return new Response('Hello World');
}

// 支持 HTTP 方法特定处理
export async function onRequestGet(context: Context): Promise<Response> {
  return new Response('GET response');
}

export async function onRequestPost(context: Context): Promise<Response> {
  return new Response('POST response');
}

export async function onRequestPut(context: Context): Promise<Response> {
  return new Response('PUT response');
}

export async function onRequestDelete(context: Context): Promise<Response> {
  return new Response('DELETE response');
}

export async function onRequestPatch(context: Context): Promise<Response> {
  return new Response('PATCH response');
}
```

### 3.2 Context 标准接口

```typescript
interface Context {
  // 请求对象（标准 Fetch API）
  request: Request;
  
  // 环境变量和密钥（仅通用配置，无平台特定参数）
  env: {
    [key: string]: string | undefined;
  };
  
  // URL 路由参数（动态参数）
  params: Record<string, string>;
  
  // 原始请求路径
  path: string;
  
  // HTTP 方法
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  
  // 查询字符串参数
  query: Record<string, string | string[]>;
  
  // 请求头
  headers: Headers;
  
  // Cookie 对象
  cookies: CookieStore;
  
  // 用户信息（若有身份验证）
  user?: {
    id: string;
    name?: string;
    email?: string;
    [key: string]: any;
  };
  
  // 缓存 API
  cache: CacheAPI;
  
  // 日志方法
  log: {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
  
  // 等待后台任务完成（不阻塞响应）
  waitUntil(promise: Promise<any>): void;
  
  // 服务绑定（KV、Database、Cache 等通过 context.services 访问）
  services: {
    kv?: KVStore;
    database?: Database;
    [key: string]: any;
  };
}

interface CookieStore {
  get(name: string): string | undefined;
  set(name: string, value: string, options?: CookieOptions): void;
  delete(name: string): void;
  getAll(): Record<string, string>;
}

interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

interface CacheAPI {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
  delete(request: Request | string): Promise<boolean>;
}
```

**关键说明**：
- **没有 `raw` 字段** — 完全禁止平台特定代码
- **没有平台检测** — 无法判断当前平台
- **所有能力通过 `services` 访问** — 统一、可预测、可迁移

---

## 4. 基础 Handler 示例

### 示例 1：最小化 Hello World

```typescript
// functions/index.ts
export default async function handler(context: Context): Promise<Response> {
  return new Response('Hello, World!', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
```

### 示例 2：JSON API 返回

```typescript
// functions/api/users.ts
export default async function handler(context: Context): Promise<Response> {
  if (context.method === 'GET') {
    const users = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' }
    ];
    return new Response(JSON.stringify(users), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  if (context.method === 'POST') {
    const data = await context.request.json();
    return new Response(JSON.stringify({ id: 3, ...data }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response('Method not allowed', { status: 405 });
}
```

### 示例 3：动态参数路由

```typescript
// functions/api/posts/[id].ts
export default async function handler(context: Context): Promise<Response> {
  const postId = context.params.id;
  return new Response(JSON.stringify({ postId, content: 'Post content' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
```

### 示例 4：使用环境变量

```typescript
// functions/api/config.ts
export default async function handler(context: Context): Promise<Response> {
  const apiKey = context.env.API_KEY;
  const logLevel = context.env.LOG_LEVEL || 'info';
  
  context.log.info(`API Key configured: ${!!apiKey}`);
  
  return new Response(JSON.stringify({ logLevel }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
```

### 示例 5：Cookie 处理

```typescript
// functions/api/session.ts
export default async function handler(context: Context): Promise<Response> {
  const sessionId = context.cookies.get('session_id');
  
  if (!sessionId) {
    context.cookies.set('session_id', 'new_session_123', {
      maxAge: 86400,
      httpOnly: true,
      path: '/'
    });
    return new Response('Session created', { status: 201 });
  }
  
  return new Response(`Session: ${sessionId}`, { status: 200 });
}
```

---

## 5. 路由规范

### 5.1 自动路由生成

函数目录结构自动映射为 HTTP 路由：

| 文件路径                    | 生成的路由                | 说明                          |
|-----------------------------|-------------------------|-------------------------------|
| `functions/index.ts`        | `/`                     | 根路由                        |
| `functions/hello.ts`        | `/hello`                | 简单路由                      |
| `functions/api/users.ts`    | `/api/users`            | 嵌套路由                      |
| `functions/api/posts/[id].ts` | `/api/posts/:id`      | 动态参数（:id 为参数名）      |
| `functions/api/[[catch]].ts`  | `/api/*`              | 捕获所有子路由（catch-all）   |

### 5.2 动态参数语法

- `[param]` → 单个动态参数（如 `/posts/[id]` → `/posts/123`）
- `[[catchall]]` → 捕获所有剩余路径（如 `/api/[[catchall]]` → `/api/a/b/c`）

---

## 6. 环境变量和密钥管理

### 6.1 定义方式

在 `.config.json` 中声明环境变量和密钥名称：

```json
{
  "environment": {
    "variables": {
      "PUBLIC_API_BASE": "https://api.example.com",
      "LOG_LEVEL": "info"
    },
    "secrets": [
      "DATABASE_URL",
      "API_KEY",
      "JWT_SECRET"
    ]
  }
}
```

### 6.2 访问方式

在函数中通过 `context.env` 访问：

```typescript
export default async function handler(context: Context): Promise<Response> {
  const dbUrl = context.env.DATABASE_URL;
  const apiKey = context.env.API_KEY;
  
  return new Response(JSON.stringify({ dbUrl: !!dbUrl }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

### 6.3 部署时注入

通过 CLI 工具部署时注入：

```bash
deploy --env production --secret DATABASE_URL="postgresql://..." --secret API_KEY="sk_..."
```

---

## 7. 存储与服务集成（KV、数据库、缓存）

### 7.1 统一服务层架构

本规范为 KV、数据库、缓存等增值服务提供**完全统一的接口**。编译器负责将这些统一接口自动适配到各个平台的原生实现。

### 7.2 KV Store 通用接口

#### 接口定义

```typescript
interface KVStore {
  // 获取值（返回字符串或 null）
  get(key: string, options?: GetOptions): Promise<string | null>;
  
  // 获取对象（自动 JSON 解析）
  getJSON<T = any>(key: string, options?: GetOptions): Promise<T | null>;
  
  // 获取值及其元数据
  getWithMetadata(key: string): Promise<{
    value: string | null;
    metadata?: Record<string, any>;
    expiresIn?: number;  // 剩余生存时间（秒）
  }>;
  
  // 设置值
  put(key: string, value: string, options?: PutOptions): Promise<void>;
  
  // 设置对象（自动 JSON 序列化）
  putJSON<T = any>(key: string, value: T, options?: PutOptions): Promise<void>;
  
  // 删除键
  delete(key: string): Promise<void>;
  
  // 批量删除
  deleteMultiple(keys: string[]): Promise<void>;
  
  // 列表查询
  list(options?: ListOptions): Promise<ListResult>;
  
  // 检查键是否存在
  exists(key: string): Promise<boolean>;
}

interface GetOptions {
  cacheTtl?: number;  // 缓存时间（秒）
}

interface PutOptions {
  expirationTtl?: number;      // 过期时间（秒）
  expirationDatetime?: Date;   // 过期日期
  metadata?: Record<string, any>;
}

interface ListOptions {
  limit?: number;
  prefix?: string;
  cursor?: string;
}

interface ListResult {
  keys: Array<{ name: string; metadata?: Record<string, any> }>;
  list_complete: boolean;
  cursor?: string;
}
```

#### 使用示例

```typescript
// functions/api/cache/user.ts
export default async function handler(context: Context): Promise<Response> {
  const kv = context.services.kv;
  
  if (context.method === 'GET') {
    const userId = context.query.id as string;
    
    // 尝试从 KV 读取
    const cached = await kv.getJSON(`user:${userId}`);
    if (cached) {
      return new Response(JSON.stringify(cached), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 如果没有缓存，从外部 API 获取
    const user = await fetch(`https://api.example.com/users/${userId}`).then(r => r.json());
    
    // 存入 KV，设置 1 小时过期
    await kv.putJSON(`user:${userId}`, user, { expirationTtl: 3600 });
    
    return new Response(JSON.stringify(user), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  if (context.method === 'DELETE') {
    const userId = context.query.id as string;
    await kv.delete(`user:${userId}`);
    return new Response('User cache cleared', { status: 200 });
  }
  
  return new Response('Method not allowed', { status: 405 });
}
```

### 7.3 Database 通用接口

#### 接口定义

```typescript
interface Database {
  // 执行查询（返回行数组）
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  
  // 执行单条查询
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | null>;
  
  // 执行更新/删除/插入
  execute(sql: string, params?: any[]): Promise<ExecuteResult>;
  
  // 事务（关键能力：必须支持）
  transaction<T>(
    callback: (tx: Database) => Promise<T>
  ): Promise<T>;
  
  // 批量操作
  batch(operations: BatchOperation[]): Promise<BatchResult[]>;
  
  // 表元数据查询
  describe(table: string): Promise<TableInfo>;
  
  // 预编译语句（可选）
  prepare?(sql: string): Statement;
}

interface ExecuteResult {
  changes: number;           // 影响行数
  lastInsertRowid?: number;  // 最后插入的 ID
}

interface BatchOperation {
  sql: string;
  params?: any[];
}

interface BatchResult {
  changes: number;
  error?: string;
}

interface TableInfo {
  name: string;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    primaryKey: boolean;
  }>;
}

interface Statement {
  bind(...params: any[]): Statement;
  run(): Promise<ExecuteResult>;
  all<T = any>(): Promise<T[]>;
  get<T = any>(): Promise<T | null>;
  free(): void;
}
```

#### 使用示例

```typescript
// functions/api/users/list.ts
export default async function handler(context: Context): Promise<Response> {
  const db = context.services.database;
  
  if (context.method === 'GET') {
    const page = parseInt(context.query.page as string) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    
    // 查询用户列表
    const users = await db.query(
      'SELECT id, name, email FROM users LIMIT ? OFFSET ?',
      [limit, offset]
    );
    
    return new Response(JSON.stringify(users), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  if (context.method === 'POST') {
    const { name, email } = await context.request.json();
    
    const result = await db.execute(
      'INSERT INTO users (name, email) VALUES (?, ?)',
      [name, email]
    );
    
    return new Response(JSON.stringify({ 
      id: result.lastInsertRowid,
      name,
      email
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  return new Response('Method not allowed', { status: 405 });
}
```

#### 事务示例（关键功能）

```typescript
// functions/api/transfer.ts
export default async function handler(context: Context): Promise<Response> {
  const db = context.services.database;
  const { fromUserId, toUserId, amount } = await context.request.json();
  
  try {
    await db.transaction(async (tx) => {
      // 扣款
      await tx.execute(
        'UPDATE users SET balance = balance - ? WHERE id = ?',
        [amount, fromUserId]
      );
      
      // 加款
      await tx.execute(
        'UPDATE users SET balance = balance + ? WHERE id = ?',
        [amount, toUserId]
      );
      
      // 记录日志
      await tx.execute(
        'INSERT INTO transactions (from_user_id, to_user_id, amount) VALUES (?, ?, ?)',
        [fromUserId, toUserId, amount]
      );
    });
    
    return new Response('Transfer completed', { status: 200 });
  } catch (error) {
    // 整个事务自动回滚
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}
```

### 7.4 配置与启用服务

在 `.config.json` 中声明需要的服务：

```json
{
  "services": {
    "kv": {
      "enabled": true,
      "binding": "KV_STORE"
    },
    "database": {
      "enabled": true,
      "binding": "DB"
    },
    "cache": {
      "enabled": true,
      "binding": "CACHE"
    }
  }
}
```

### 7.5 平台能力兼容性矩阵

| 功能                | Cloudflare | Deno Deploy | Tencent EdgeOne | 说明                 |
|-------------------|-----------|-----------|---------------|-------------------|
| KV Store          | ✅ KV     | ✅ KV     | ✅ KV         | 所有平台都支持         |
| 数据库事务         | ✅ D1     | ✅ 自实现  | ✅ 支持       | 所有平台都支持         |
| 批量操作           | ✅        | ✅        | ✅            | 所有平台都支持         |
| TTL/过期管理       | ✅        | ✅        | ✅            | 所有平台都支持         |
| 元数据             | ✅        | ✅        | ✅            | 所有平台都支持         |

**说明**：编译器在编译时验证所有使用的功能都被目标平台支持，不支持的功能会报错。

---

## 8. 本地开发与测试

### 8.1 本地开发服务器

```bash
dev
# 启动本地开发服务器，默认在 http://localhost:8000
# 支持热重载
# 自动模拟 KV、数据库等服务
```

### 8.2 本地环境变量

创建 `.env` 文件用于本地开发：

```
LOG_LEVEL=debug
DATABASE_URL=sqlite://./local.db
API_KEY=test_key_12345
```

### 8.3 测试 Handler

```bash
test
# 运行单元测试
```

---

## 9. 构建和发布

### 9.1 本地构建

```bash
build
# 输出到 ./dist 目录
# 生成通用构建产物
```

### 9.2 验证兼容性

```bash
validate
# 检查项目是否符合规范
# 验证所有 Handler 接口
# 检查所有服务都被目标平台支持
```

### 9.3 多平台发布

编译时，CLI 工具会根据 `.config.json` 中的 `vendors` 配置，自动生成各平台对应的配置文件并发布。

```bash
# 发布到所有已启用的平台
deploy

# 发布到特定平台
deploy --vendor cloudflare
deploy --vendor deno
deploy --vendor tencent

# 指定环境
deploy --env production

# 指定版本/标签
deploy --tag v1.0.0
```

### 9.4 预览和回滚

```bash
# 查看部署历史
deployments list

# 预览特定版本
preview --deployment <id>

# 回滚到上一个版本
rollback

# 回滚到特定版本
rollback --deployment <id>
```

---

## 10. 错误处理标准

### 10.1 标准错误响应格式

```typescript
interface ErrorResponse {
  error: {
    code: string;              // 错误码（如 'INVALID_REQUEST'）
    message: string;           // 错误描述
    details?: Record<string, any>; // 详细错误信息
    timestamp: string;         // ISO 8601 时间戳
    requestId?: string;        // 请求 ID（用于追踪）
  };
}

// 使用示例
export default async function handler(context: Context): Promise<Response> {
  try {
    const data = await context.request.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: {
        code: 'PARSE_ERROR',
        message: 'Invalid JSON in request body',
        timestamp: new Date().toISOString()
      }
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
```

---

## 11. 性能与限制

### 11.1 通用限制

| 限制项              | 值                    | 说明           |
|------------------|---------------------|----------------|
| 最大执行时间        | 30 秒                | 单个请求超时   |
| 最大请求体大小      | 50 MB               | POST 数据限制  |
| 最大响应体大小      | 50 MB               | 返回数据限制   |
| 并发请求数          | 1000 (可配置)       | 平台相关       |
| 内存限制            | 128 MB (可配置)     | 运行时环境     |

### 11.2 冷启动优化

- 保持 Handler 体积小（< 1 MB）
- 避免重型依赖，使用 Tree-shaking
- 预连接常用的外部服务

---

## 12. 适配器层实现指南

### 12.1 编译流程

源码项目（.config.json + functions/ 目录）编译时，CLI 工具会：

1. 读取 `.config.json`，验证兼容性
2. 根据 `vendors` 配置中启用的平台，为每个平台生成适配产物
3. 每个产物目录包含：
   - 平台专用配置文件（如 wrangler.toml、deno.json）
   - 转换后的 Handler 代码（符合该平台的入口点和导出方式）
   - 依赖管理文件
   - 服务适配器代码（KV、DB 等的平台专用实现）

### 12.2 编译输出示例

编译后（dist/ 目录）：
```
dist/
├── cloudflare/
│   ├── wrangler.toml
│   ├── src/
│   │   ├── index.ts
│   │   └── adapters/
│   │       ├── kv.ts
│   │       └── db.ts
│   └── package.json
├── deno/
│   ├── deno.json
│   ├── functions/
│   │   ├── index.ts
│   │   └── adapters/
│   │       ├── kv.ts
│   │       └── db.ts
│   └── deno.lock
└── tencent/
    ├── edgeone.toml
    ├── functions/
    │   ├── index.ts
    │   └── adapters/
    │       ├── kv.ts
    │       └── db.ts
    └── package.json
```

### 12.3 服务适配器例子

**Cloudflare 的 KV 适配器**：
```typescript
// dist/cloudflare/src/adapters/kv.ts
export function createKVAdapter(namespace: any): KVStore {
  return {
    async get(key: string) {
      return namespace.get(key);
    },
    async getJSON(key: string) {
      const value = await namespace.get(key);
      return value ? JSON.parse(value) : null;
    },
    async put(key: string, value: string, options?: any) {
      return namespace.put(key, value, {
        expirationTtl: options?.expirationTtl
      });
    },
    // ... 其他方法
  };
}
```

**Deno Deploy 的 KV 适配器**：
```typescript
// dist/deno/functions/adapters/kv.ts
export function createKVAdapter(db: Deno.Kv): KVStore {
  return {
    async get(key: string) {
      const res = await db.get([key]);
      return res.value as string | null;
    },
    async getJSON(key: string) {
      const res = await db.get([key]);
      return res.value as any;
    },
    async put(key: string, value: string, options?: any) {
      await db.set([key], value, {
        expireIn: options?.expirationTtl ? options.expirationTtl * 1000 : undefined
      });
    },
    // ... 其他方法
  };
}
```

---

## 13. CLI 工具命令参考

```bash
# 初始化新项目
init [project-name]

# 安装依赖
install

# 本地开发
dev [--port 8000]

# 验证规范与兼容性
validate

# 构建项目（生成各平台产物）
build

# 运行测试
test

# 部署（自动编译并发布）
deploy [--vendor cloudflare|deno|tencent] [--env production|staging]

# 查看部署历史
deployments list [--vendor cloudflare]

# 预览特定部署
preview --deployment <id>

# 回滚
rollback [--deployment <id>]

# 查看日志
logs [--deployment <id>] [--tail]

# 配置管理（存储平台特定参数如 account ID、org 等）
config set <key> <value>
config get <key>

# 帮助
--help
<command> --help
```

---

## 14. 版本控制和兼容性

### 14.1 版本信息

- **规范版本**：1.0
- **发布日期**：2025-01-01
- **兼容平台**：
  - Cloudflare Workers/Pages (v2+)
  - Deno Deploy (v1.25+)
  - Tencent EdgeOne Pages (v1+)

### 14.2 后向兼容性

本规范承诺在主版本号（如 1.x）内保持后向兼容。

---

## 15. 代码审查与规范检查

编译器（CLI 工具）会自动检查并拒绝以下代码：

```typescript
// ❌ 会被编译器拒绝
export default async function handler(context: Context) {
  // 检测平台类型 → 错误
  if (typeof Cloudflare !== 'undefined') { }
  
  // 条件导入 → 错误
  const mod = await import(condition ? 'a' : 'b');
  
  // 直接访问 env 中的平台特定字段 → 错误
  const cfKV = context.env.MY_NAMESPACE;
  
  // 检查 context 中是否存在 raw → 错误（不存在该字段）
  if (context.raw) { }
}
```

---

## 16. 项目初始化示例

使用 CLI 初始化一个新项目：

```bash
init hello-edge-app
cd hello-edge-app
```

生成的项目结构：
```
hello-edge-app/
├── functions/
│   ├── index.ts
│   └── api/
│       └── hello.ts
├── .config.json
├── .env
├── package.json
└── README.md
```

`.config.json` 内容（模板）：
```json
{
  "version": "1.0",
  "name": "hello-edge-app",
  "description": "My first edge function project",
  "runtime": "standard-v1",
  "language": "typescript",
  "entryPoint": "functions/index.ts",
  "functionRoot": "./functions",
  "routing": {
    "caseSensitive": false,
    "dynamicParamPattern": "[param]",
    "catchAllPattern": "[[catchall]]"
  },
  "environment": {
    "variables": {},
    "secrets": []
  },
  "services": {
    "kv": { "enabled": false },
    "database": { "enabled": false },
    "cache": { "enabled": false }
  },
  "build": {
    "outDir": "./dist",
    "minify": true,
    "sourceMap": false
  },
  "vendors": {
    "cloudflare": { "enabled": true },
    "deno": { "enabled": true },
    "tencent": { "enabled": true }
  },
  "limits": {
    "maxExecutionTime": 30000,
    "maxPayloadSize": 52428800,
    "maxConcurrency": 1000
  }
}
```

---

## 参考资源

- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [Cloudflare KV 文档](https://developers.cloudflare.com/workers/runtime-apis/kv/)
- [Cloudflare D1 文档](https://developers.cloudflare.com/workers/runtime-apis/d1/)
- [Deno Deploy 文档](https://docs.deno.com/deploy/)
- [Deno KV 文档](https://docs.deno.com/deploy/kv/manual/)
- [腾讯 EdgeOne 文档](https://pages.edgeone.ai/zh/document/product-introduction)
- [Web Fetch API](https://fetch.spec.whatwg.org/)

---

## 附录：规范的核心保证

本规范的目标是：

1. **代码完全通用** — 开发者编写的代码与平台无关
2. **一次编写、随处部署** — 同一份源码可不加修改地部署到任何支持的平台
3. **零平台泄漏** — 编译器会主动检查并禁止任何平台特定代码
4. **高度可维护** — 未来迁移到新平台无需修改业务代码

---

**说明**：本规范持续演进，欢迎反馈和贡献。
