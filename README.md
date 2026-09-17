# 多租户数据 Agent Harness

一个面向个人数据抓取、分析与记忆的 Agent Harness 参考实现。项目参考 DeepSeek Harness 的插件化、Turn/Step 生命周期和追加式事件模型，同时将租户授权、能力令牌、Secret 引用和对象路径策略固定为不可绕过的安全边界。

当前已完成架构文档定义的 Phase 1-3，并补充了生产存储接入的迁移基线。代码可运行、可测试，但内存存储和本地 Worker 仅用于验证架构契约，不能直接作为生产部署。

## 状态报告

| 范围 | 状态 | 说明 |
| --- | --- | --- |
| 租户上下文与资源隔离 | 已实现 | 每次资源、会话、记忆和 grant 操作均需要可信 `ActorContext`。 |
| Turn/Step 与事件日志 | 已实现 | 工具提案、授权、结果、失败和结束状态均追加记录。 |
| 能力授权 | 已实现 | grant 有租户、会话、回合、工具、资源、连接和过期时间范围。 |
| 记忆、提示词与模型边界 | 已实现 | 记忆检索固定当前租户；模型仅收到净化后的提示词消息。 |
| 数据分析 Worker 协议 | 已实现 | 本地参考 Worker 按 grant 执行 `dataset.aggregate`。 |
| Profile 与插件治理 | 已实现 | 生产注册表只接受受信任 Ed25519 签名 Profile 中精确声明的插件。 |
| 回放、导出与删除 | 已实现 | 支持会话只读回放、租户自助导出和显式确认删除内存数据。 |
| PostgreSQL RLS 迁移 | 已提供，未执行 | 已提交 SQL；本机没有 PostgreSQL，尚未做真实数据库集成测试。 |
| KMS/Vault、OAuth、容器 Worker | 待接入 | 必须在生产环境使用真实基础设施替换本地适配器。 |

## 前置条件

- Node.js 22 或更高版本。
- `npm install` 会安装 PostgreSQL 驱动与 Mem0 Platform SDK。

## 验证

在项目根目录执行：

```sh
npm test
```

当前测试覆盖 14 个安全与行为契约，包括跨租户资源/会话/连接隔离、内存检索隔离、能力范围、Worker 对象路径、Secret 拦截、签名 Profile、防篡改、回放和用户数据删除。

## 本地启动

本项目已在 macOS PostgreSQL 18 上验证。PostgreSQL 命令行工具的安装路径为 `/Library/PostgreSQL/18/bin`。项目本地开发实例使用 `.local/postgres` 数据目录，仅监听 `127.0.0.1:55432`，避免占用系统默认 5432 端口。

首次初始化开发实例：

```sh
mkdir -p .local
/Library/PostgreSQL/18/bin/initdb -D "$PWD/.local/postgres" --username=admin --auth=trust
/Library/PostgreSQL/18/bin/pg_ctl -D "$PWD/.local/postgres" -l "$PWD/.local/postgres.log" -o '-h 127.0.0.1 -p 55432' start
/Library/PostgreSQL/18/bin/createdb -h 127.0.0.1 -p 55432 -U admin data_agent
```

`--auth=trust` 仅适合该本机、回环地址开发实例。生产环境必须使用受管理身份、密码或证书认证，不能沿用此配置。

设置本地开发连接串、执行迁移并启动状态服务：

```sh
export DATABASE_URL='postgresql://admin@127.0.0.1:55432/data_agent'
export APP_ENV=development
export MODEL_API_KEY='your-provider-api-key'
export MODEL_BASE_URL='https://api.deepseek.com'
export MODEL_NAME='deepseek-chat'
# Optional: enable Mem0 Platform for long-term memory extraction and semantic recall.
export MEMORY_PROVIDER='mem0'
export MEM0_API_KEY='your-mem0-platform-api-key'
npm run migrate
npm run seed:dev
npm start
```

服务默认仅监听 `127.0.0.1:3000`。浏览器打开 `http://127.0.0.1:3000` 可输入问题；`POST /api/agent/messages` 会依次执行当前租户的记忆检索、提示词组装和模型请求，并持久化 Turn/Step 事件。该输入接口仅在 `APP_ENV=development` 下可用，不能替代生产认证或用户数据 API。

`npm run seed:dev` 会幂等创建三个开发租户：Alice、Bob、Carol。聊天页右上角的租户选择器会在这三个隔离空间间切换；会话和审计事件始终写入 PostgreSQL。未配置 Mem0 时，应用继续从 PostgreSQL 检索旧记忆；配置 `MEMORY_PROVIDER=mem0` 与 `MEM0_API_KEY` 后，长期记忆的提取和语义检索改由 Mem0 Platform 处理。

聊天页左侧会显示当前租户拥有的历史会话。刷新页面后，应用通过 `GET /api/agent/sessions` 加载会话列表，并通过 `GET /api/agent/sessions/{sessionId}/events` 回放用户和助手消息；两个接口均按当前租户和主体检查 Session 归属。

`npm start`、`npm run migrate` 与 `npm run seed:dev` 会通过 Node 原生 `--env-file-if-exists=.env` 自动加载 `.env`。该文件已经被 `.gitignore` 排除；不要把它提交到版本控制。

`MODEL_BASE_URL` 接受 OpenAI 兼容的 Chat Completions 服务。DeepSeek 官方示例使用 `https://api.deepseek.com` 作为 base URL，`deepseek-chat` 作为模型名；请求发送至 `/chat/completions`。未设置 `MODEL_NAME` 时，应用默认使用 `deepseek-chat`；其他提供商应显式设置它。[DeepSeek Node.js 示例](https://api-docs.deepseek.com/api_samples/chat_nodejs/)

### Mem0 长期记忆

Mem0 不是只增加一个 import：它接管长期记忆的写入和检索，PostgreSQL 继续保存会话、消息和审计事件。每次模型调用前，`Mem0MemoryStore` 使用由可信 `ActorContext` 推导出的 `tenant:{tenantId}:actor:{actorId}` 作为 `user_id` 过滤器检索记忆；每次模型回复后，它把本轮用户和助手消息发送到 Mem0，由 Mem0 提取长期记忆。返回结果还必须同时匹配写入时的 `tenantId` 与 `actorId` 元数据，才可以进入提示词。

配置后，聊天内容会发送到 Mem0 Platform，因此请先确认其数据处理政策符合你的产品与用户授权要求。`MEM0_API_KEY` 只放在 `.env`，不要提交。若不设置该变量，应用默认继续使用 PostgreSQL 记忆存储；设置 `MEMORY_PROVIDER=mem0` 但未设置 API key 时，应用会拒绝启动，避免静默降级。

验证服务：

```sh
curl --fail --silent http://127.0.0.1:3000/health
```

预期响应：

```json
{"status":"ok","database":"data_agent"}
```

停止本地数据库：

```sh
/Library/PostgreSQL/18/bin/pg_ctl -D "$PWD/.local/postgres" stop
```

## 最小使用示例

以下示例创建两个租户、为 Alice 创建数据集，并以受限工具读取数据集摘要。应用层应仅从已经验证的身份 Claims 创建 `ActorContext`，不可接受客户端提交的 `tenantId`。

```js
import {
  AgentHarness,
  CapabilityBroker,
  PluginRegistry,
  SessionEventLog,
  TenantStore,
  createActorContext,
  dataCatalogPlugin,
} from './src/index.js';

const store = new TenantStore();
const registry = new PluginRegistry({ allowUnverifiedPlugins: true }); // 仅开发环境
registry.use(dataCatalogPlugin);

const broker = new CapabilityBroker({
  resourceStore: store,
  allowedTools: new Set(['dataset.summary']),
});
const events = new SessionEventLog();
const harness = new AgentHarness({
  eventLog: events,
  capabilityBroker: broker,
  pluginRegistry: registry,
  resourceStore: store,
});

const alice = createActorContext({ actorId: 'alice', tenantId: 'tenant-alice' });
store.create(alice, {
  id: 'revenue-2026',
  type: 'dataset',
  data: { rows: [{ city: 'Shanghai', revenue: 42 }] },
});

const sessionId = harness.createSession(alice);
const response = harness.runToolTurn(alice, {
  sessionId,
  toolName: 'dataset.summary',
  input: { datasetId: 'revenue-2026' },
  resourceIds: ['revenue-2026'],
});

console.log(response.result);
// { datasetId: 'revenue-2026', fieldNames: ['city', 'revenue'], rowCount: 1, ... }
```

### 记忆与模型调用

`TenantMemoryStore` 的 API 没有调用方可选的 `tenantId` 参数。当前租户仅由 `ActorContext` 决定，`PromptAssembler` 会拒绝任何归属其他租户的记忆。

```js
import { ModelAdapter, PromptAssembler, TenantMemoryStore } from './src/index.js';

const memoryStore = new TenantMemoryStore();
memoryStore.remember(alice, {
  sourceId: 'preference-1',
  content: '用户偏好按城市比较收入。',
});

const promptAssembler = new PromptAssembler({
  systemInstructions: '只使用当前用户已授权的数据回答问题。',
});
const modelAdapter = new ModelAdapter({
  name: 'provider-adapter',
  respond: ({ messages }) => ({ message: `已收到 ${messages.length} 条上下文消息。` }),
});

// 将 memoryStore、promptAssembler、modelAdapter 注入 AgentHarness 后：
// harness.runModelTurn(alice, { sessionId, userMessage: '按城市汇总收入' });
```

真实模型适配器只能实现 `ModelAdapter.respond()`；它不应接收数据库句柄、KMS/Vault 客户端、原始连接凭据或未授权工具执行器。

### 分析 Worker

注册 `dataAnalysisPlugin` 并允许 `dataset.aggregate` 后，可通过分析工具计算 `count`、`sum` 或 `average`。工具不直接访问对象存储，而是经由 `LocalAnalysisWorker` 的 grant 约束接口执行。输出路径固定为：

```text
tenants/{tenantId}/sessions/{sessionId}/turns/{turnId}/...
```

生产环境应以隔离容器、网络出口白名单、非 root 用户、只读根文件系统、资源配额和短期 IAM 凭据替换 `LocalAnalysisWorker`。

### 生产插件 Profile

`PluginRegistry` 默认拒绝未验证插件。生产部署应使用 `SignedProfileLoader`，并将受信任的 Ed25519 公钥配置在部署环境中：

```js
const registry = new PluginRegistry();
const loader = new SignedProfileLoader({ trustedSigners });
loader.load(signedProfile, pluginImplementations, registry);
```

签名覆盖 Profile 名称、版本、插件顺序和每个插件的名称、版本、API 版本、能力及权限声明。修改任一内容都会导致验签失败。

## 模块说明

| 模块 | 职责 |
| --- | --- |
| [actor-context.js](./src/actor-context.js) | 经过认证后创建不可变租户/主体上下文。 |
| [capability-broker.js](./src/capability-broker.js) | 签发、校验和撤销最小范围的短期 grant。 |
| [harness.js](./src/harness.js) | 驱动工具 Turn/Step 和模型 Turn，并记录事件。 |
| [event-log.js](./src/event-log.js) | 租户范围内的追加式 Session 事件日志。 |
| [memory-store.js](./src/memory-store.js) | 受租户约束的长期记忆存储与检索。 |
| [prompt.js](./src/prompt.js) / [model-adapter.js](./src/model-adapter.js) | 模型可见上下文与可替换模型适配器边界。 |
| [local-worker.js](./src/local-worker.js) | 分析 Worker 的本地参考协议。 |
| [connection-catalog.js](./src/connection-catalog.js) | 仅存 KMS/Vault Secret 引用的第三方连接目录。 |
| [object-storage-policy.js](./src/object-storage-policy.js) | 从 grant 推导和校验对象存储路径。 |
| [profile-loader.js](./src/profile-loader.js) / [plugins.js](./src/plugins.js) | 已签名 Profile、manifest 精确匹配和插件注册边界。 |
| [session-replay.js](./src/session-replay.js) | 从事件构建只读会话时间线，不重复执行工具。 |
| [data-lifecycle.js](./src/data-lifecycle.js) | 当前租户的数据导出与显式确认删除。 |

## 安全边界

- `tenantId` 只能来自已验证的 `ActorContext`，不能来自 HTTP body、工具参数、模型输出或用户提示词。
- 模型提出工具调用，不等于工具获得执行权；每个调用均需经过 schema、资源归属、Profile、预算和 grant 校验。
- Secret 不得存入连接目录、事件、记忆、模型消息或日志。连接目录只保存 `vault://` 或 `kms://` 引用。
- 跨租户资源和会话统一表现为不可见，避免泄露资源是否存在。
- 插件不是沙箱。生产插件需要审核、固定版本和签名 Profile；不可信第三方代码必须放入隔离执行面。
- `TenantDataLifecycle.erase()` 仅删除当前内存适配器中的资源、记忆和会话。生产删除还需覆盖对象、向量、缓存、Secret 吊销和备份过期流程。

## PostgreSQL RLS 基线

[db/migrations/001_tenant_isolation.sql](./db/migrations/001_tenant_isolation.sql) 创建 `datasets`、`connections`、`memory_items` 和 `session_events`，并为每张私有表启用和强制 RLS。应用运行角色必须：

1. 与迁移所有者分离，且没有 `BYPASSRLS`。
2. 在每个私有数据事务开始时，用已验证的租户 ID 执行 `SET LOCAL app.tenant_id = '...'`。
3. 通过 `(tenant_id, id)` 查询资源，而不是全局 ID 查询后再用应用代码判断归属。

完整的迁移使用与集成验证要求见 [db/README.md](./db/README.md)。当前机器没有 PostgreSQL 客户端或服务，因此该 SQL 尚未执行，不能将 Node 契约测试视为 RLS 集成验证。

## 文档索引

- [ARCHITECTURE.md](./ARCHITECTURE.md)：全局多用户数据、配置、凭据和记忆隔离架构。
- [HARNESS_ARCHITECTURE.md](./HARNESS_ARCHITECTURE.md)：Harness 插件、事件、Turn/Step、Worker 和治理设计。
- [db/README.md](./db/README.md)：PostgreSQL RLS 部署要求。

## 生产落地清单

在对外提供抓取或接入用户账号前，至少完成以下工作：

1. 在 PostgreSQL 集成环境执行迁移，并以运行角色进行 A/B 租户的 `SELECT`、`INSERT`、`UPDATE`、`DELETE` RLS 攻击测试。
2. 用 KMS/Vault 实现 `secretRef` 解析、轮换与撤销；禁止任何明文凭据进入应用进程日志、队列或模型请求。
3. 将本地 Store/Event Log/Memory Store 替换为持久化实现，并保持相同的租户范围接口。
4. 将本地 Worker 替换为隔离容器或远程执行池，接入网络白名单、SSRF 防护、配额、短期 IAM 和临时目录清理。
5. 用真实模型提供商适配器替换示例 `ModelAdapter`，确认其数据保留政策并实现请求脱敏。
6. 将 Profile 签名私钥保存在 CI/CD 或密钥系统，运行时仅部署受信任公钥和已签名 Bundle。
7. 扩展删除流程，清除对象、向量索引、缓存、预签名 URL 和备份中的到期副本。
