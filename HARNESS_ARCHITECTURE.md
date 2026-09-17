# 多租户数据 Agent Harness 架构

## 1. 设计结论

本系统采用“**受策略约束的可组合 Harness**”架构：模型、提示词、工具适配器、抓取器、分析器、记忆检索器、调度器和界面均可作为插件替换；身份认证、租户授权、密钥解封、审计与执行隔离则属于不可被业务插件绕过的安全内核。

设计参考 DeepSeek Harness 的三个思想：

1. 以插件组合运行时能力，而非将 Agent 循环、工具和会话日志固化在单体服务中。
2. 使用追加式会话事件记录回合（turn）和步骤（step），支持重放、恢复、审计与故障定位。
3. 将模型请求和工具执行设计为可插入策略的管线，使安全、预算、审批和可观测性能在执行前介入。

本设计不直接依赖或复刻 DeepSeek Harness/Cordis 的实现。DeepSeek Harness 仍处于开发者预览且可能存在兼容性变更，因此产品应定义稳定的自有契约，并在需要时通过适配器接入其运行时。

## 2. 目标、范围与原则

### 2.1 目标

为每位用户提供独立的个人数据 Agent，使其能够：

- 保存个人偏好和经确认的长期记忆。
- 连接自己的 API Key、OAuth 社交账号或已授权数据源。
- 创建抓取、清洗、分析和导出任务。
- 在可追溯、可暂停、可恢复的回合中通过 Agent 使用这些能力。

系统必须保证 A 用户无法读取、修改、推断或经 Agent 上下文得到 B 用户的私有配置、凭据、数据、任务、记忆或运行痕迹。

### 2.2 架构原则

| 原则 | 含义 |
| --- | --- |
| 插件可替换 | 模型、工具、数据源和界面按明确契约组合，不在循环中硬编码厂商逻辑。 |
| 安全不可替换 | 插件可扩展能力，不能改变租户身份、资源授权、Secret 解封和审计的最终判定。 |
| 事件先行 | 会话与工具结果以不可变事件追加；投影、缓存、提示词历史均可重建。 |
| 默认拒绝 | 没有可信租户上下文、资源授权或工具能力令牌时，操作一律失败。 |
| 最小能力 | Agent 得到针对当前回合、资源和动作签发的能力，而非全局数据库或存储权限。 |
| 副作用显式化 | 模型只能提出工具调用；所有网络、存储、凭据与导出副作用经执行管线授权。 |
| 可恢复而非重试猜测 | 以持久步骤状态和幂等键恢复未完成工作，避免重复抓取、重复写入或重复扣费。 |

## 3. 总体架构

```text
                         控制面
┌──────────┐   JWT/OIDC   ┌───────────────────────┐
│ Web / API├─────────────>│ Identity + Tenant Gate │
└────┬─────┘              └──────────┬────────────┘
     │ 可信 ActorContext              │ policy decision
     v                                v
┌──────────────────────────────────────────────────────┐
│                 Agent Harness Runtime                 │
│  Session Driver -> Turn/Step Loop -> Plugin Context   │
│       |                 |                   |         │
│  Event Log          Prompt/Model        Tool Pipeline │
│       |                 |                   |         │
└───────┼─────────────────┼───────────────────┼─────────┘
        │                 │                   │
        v                 v                   v
┌───────────────┐  ┌───────────────┐  ┌─────────────────┐
│ Tenant Memory │  │ Model Adapter │  │ Capability Broker│
│ + Data Catalog│  │ (replaceable) │  │ (non-bypassable) │
└───────┬───────┘  └───────────────┘  └───────┬─────────┘
        │                                      │ short-lived grants
        v                                      v
┌────────────────┐                    ┌──────────────────┐
│ RLS DB / Vector│                    │ Isolated Worker  │
│ Object Storage │                    │ crawler/analyzer │
└────────────────┘                    └───────┬──────────┘
                                                v
                                         External APIs/sites
```

### 3.1 三个平面

- **Harness 平面**：拥有回合循环、会话事件、提示词装配、模型流、工具声明与插件生命周期。它不拥有跨租户数据访问权。
- **能力平面**：执行抓取、分析、文件读写、导出、通知等副作用。每次执行必须携带能力令牌，并在受限 Worker 中运行。
- **安全与数据平面**：拥有身份、授权、密钥、审计、数据库 RLS、对象存储策略和记忆过滤。该平面的判定不能由模型、提示词或普通插件覆盖。

## 4. 运行时组合模型

每个运行实例由一个不可变的基础 Bundle 和按产品配置启用的插件 Bundle 组成。

```text
base-secure
  ├─ tenant-context
  ├─ authorization-policy
  ├─ session-event-log
  ├─ audit-sink
  └─ capability-broker

data-agent-profile
  ├─ prompt-builder
  ├─ model-provider/{provider}
  ├─ tools/data-catalog
  ├─ tools/job-control
  ├─ tools/analysis
  ├─ memory/retrieval
  ├─ datasource/{provider}
  └─ ui/{web|api|headless}
```

### 4.1 插件分类

| 类别 | 可插拔内容 | 必须遵守的边界 |
| --- | --- | --- |
| 模型插件 | 提供商路由、请求格式、流式响应、模型选择 | 只能收到已净化的上下文；不能获得 Secret 或数据库连接。 |
| 提示词插件 | 系统段落、任务模板、数据集摘要 | 不可将其他租户内容、内部路径或凭据写入提示词。 |
| 工具插件 | 抓取、分析、数据查询、导出、通知 | 工具 schema 不是授权；必须经能力经纪人执行。 |
| 数据源插件 | OAuth/API 适配、请求转换、分页解析 | 只能使用为当前连接和任务签发的短期凭据。 |
| 记忆插件 | 写入策略、检索、重排序、摘要 | 所有读写均固定当前 `tenant_id`，禁止全局 collection 查询。 |
| 表面插件 | Web、API、CLI、Webhook | 只提交用户意图，不能自行构造可信 ActorContext。 |
| 观测插件 | 指标、追踪、告警、回放 UI | 只能订阅脱敏事件，不能取得原始 Secret。 |

### 4.2 不可被插件覆盖的安全内核

下列接口由基础 Bundle 提供，插件只能调用，不能替换、卸载或短路：

- `ActorContext` 的验证和签发。
- 租户与资源归属检查。
- Secret 引用的解析、解封与轮换。
- 能力令牌的签发、校验、撤销和过期。
- 审计事件的追加与保留策略。
- 数据库租户上下文设置、RLS 运行账号约束。
- Worker 沙箱、网络出口、临时文件与对象存储路径约束。

这与“一切皆插件”并不矛盾：可插拔的是业务能力的实现，不是信任根。若插件能够重写授权结果，系统只有可组合性，没有隔离性。

## 5. Agent 生命周期：Turn 与 Step

一个 **Turn** 是一次由用户消息、定时任务或恢复信号触发的完整工作单元；一个 Turn 包含零到多个 **Step**。一个 Step 对应一次模型请求及其产生的工具调用。

```text
turn.start
  -> claim inbox message / resumable input
  -> policy.pre-turn
  -> step.start
     -> prompt.compose
     -> memory.retrieve (tenant-scoped)
     -> model.request / model.stream
     -> assistant.message
     -> tool.call x N
        -> tool.authorize
        -> tool.pre-execute
        -> tool.execute (isolated worker)
        -> tool.post-execute
        -> tool.result
     -> step.end
  -> continue only when queued work is owed and budget permits
  -> turn.stopping
turn.end
```

### 5.1 事件分类

| 事件类别 | 示例 | 持久化 | 用途 |
| --- | --- | --- | --- |
| 事实事件 | `turn.started`、`assistant.message`、`tool.result`、`turn.ended` | 必须追加写入 | 重放、恢复、审计和用户可见历史。 |
| 意图事件 | `tool.call.proposed`、`memory.write.requested` | 必须追加写入 | 记录模型提出的动作，不能等同于已执行。 |
| 判定事件 | `tool.authorized`、`tool.denied`、`approval.granted` | 必须追加写入 | 解释为什么副作用被允许或拒绝。 |
| 副作用事件 | `job.created`、`export.generated`、`secret.used` | 必须追加写入 | 用幂等键防止恢复时重复执行。 |
| 临时事件 | token chunk、UI typing、内部进度 | 可选，不作为真相来源 | 实时体验和诊断。 |

事件必须至少包含 `event_id`、`session_id`、`turn_id`、`tenant_id`、`actor_id`、`timestamp`、`schema_version`、`correlation_id` 和脱敏后的 payload。`tenant_id` 由可信 ActorContext 填入，任何插件提供的值都不可信。

### 5.2 恢复与幂等

- `step.started` 之后但尚未 `step.ended` 的步骤在进程重启后进入 `RECOVERING`，而非直接重放模型请求。
- 每个外部副作用都有 `idempotency_key = hash(tenant_id, turn_id, step_id, tool_call_id, operation)`。
- 恢复器优先查询已有 `tool.result` 或下游任务状态；只有确认未发生时才重新执行。
- 流式模型响应不可安全地从中点续传时，记录已接收内容、标记中断，并创建新的、可追溯的恢复步骤。

## 6. 工具执行与能力授权

模型输出仅是 `ToolProposal`，而不是可执行命令。Harness 将其交给能力经纪人，生成具有最小范围的 `CapabilityGrant`。

```text
ToolProposal
  -> schema validation
  -> tenant/resource validation
  -> policy evaluation + budget/approval check
  -> CapabilityGrant
  -> isolated execution
  -> sanitized ToolResult
  -> durable events
```

`CapabilityGrant` 应包含：

```ts
type CapabilityGrant = {
  grantId: string
  tenantId: string
  sessionId: string
  turnId: string
  tool: string
  allowedResourceIds: string[]
  allowedObjectPrefixes: string[]
  connectionId?: string
  maxNetworkRequests: number
  expiresAt: string
  approvalId?: string
}
```

授权判定顺序固定如下：

1. 认证上下文是否有效，且 `tenant_id` 是否存在。
2. 工具是否在该 Agent Profile 的允许清单中。
3. 参数是否匹配 schema，资源是否属于当前租户。
4. 行为是否落在策略、预算、频率和数据分类允许范围。
5. 是否需要用户确认，例如导出、写入第三方、扩大抓取范围、删除数据。
6. 签发一次性或短期能力令牌，并将授权结论写入事件日志。

任何失败返回对用户安全的错误说明，同时写入 `tool.denied` 审计事件。不得将“模型已调用此工具”误记为“工具已成功执行”。

## 7. 多租户状态与记忆

### 7.1 状态所有权

| 状态 | 归属 | 存储 | 读取条件 |
| --- | --- | --- | --- |
| Session/Turn/Step 事件 | 租户 + 会话 | 追加式关系库或事件库 | `tenant_id` RLS + 会话归属校验 |
| 用户偏好 | 租户 | 配置表 | 仅当前租户 |
| 长期记忆 | 租户 | 关系库 + 向量库 | 服务端固定 metadata filter |
| 抓取原始数据与结果 | 租户 | 对象存储 + 数据目录 | 租户前缀与短期 URL |
| 第三方连接 | 租户 | 元数据表 + Vault/KMS | Secret 仅在获准执行期间解封 |
| 运行缓存 | 租户 + 会话/任务 | 缓存服务 | key 必含 `tenant_id` |

### 7.2 记忆写入与读取契约

- 记忆写入是独立工具：模型只能提出摘要，策略插件决定是否可保存、数据分类、TTL 和可见范围。
- `PRIVATE` 和 `SECRET` 原文默认不进入长期记忆；token、Cookie、API Key、支付信息和完整身份材料永不写入。
- 检索接口必须是 `retrieve(tenantId, query, filter)`，并由服务层注入 `tenantId`；不得暴露 `retrieve(query)` 这类无租户参数的通用接口。
- 每条记忆记录来源会话/数据集、写入原因、保留期、删除状态；用户可查看、修改和删除。
- Agent 只获得检索到的必要片段。历史全量、原始爬取文本和其他会话不可因“可能有用”而自动加入上下文。

## 8. 数据源与 Worker 隔离

### 8.1 连接模型

`Connection` 记录 `tenant_id`、提供商、授权 scope、Secret 引用、状态和过期时间。明文 Key、refresh token 与 Cookie 不得进入应用数据库、会话事件、模型输入或日志。

Worker 只可通过 `resolveConnection(grant, connectionId)` 获取当前执行所需的短期凭据。该函数同时验证 `grant.tenantId == connection.tenant_id`，并限制提供商、scope、有效期与任务用途。

### 8.2 Worker 契约

```text
Harness -> Worker
  input: signed CapabilityGrant + explicit data references + sanitized parameters
  output: typed ToolResult + object references + audited status

Worker may not:
  accept arbitrary tenantId or object path
  reuse browser profile / cookie jar between tenants
  receive global storage credentials
  call internal/private network addresses
  return raw Secret in an error or result
```

每个任务使用独立容器或等价隔离单元，具备非 root 用户、只读根文件系统、按任务临时目录、CPU/内存/时长配额、出口白名单和 SSRF 防护。任务产物只能写入 `tenants/{tenant_id}/jobs/{job_id}/...`。

## 9. 插件 API 和版本治理

### 9.1 最小插件契约

```ts
type HarnessPlugin = {
  manifest: {
    name: string
    version: string
    capabilities: string[]
    requiredPermissions: string[]
    apiVersion: string
  }
  register(ctx: PluginContext): Disposable
}

type PluginContext = {
  events: ScopedEventBus
  tools: ToolRegistry
  prompts: PromptRegistry
  services: ReadonlyServiceLocator
  // No raw database, KMS, or unrestricted network handle is exposed.
}
```

- 插件只能注册命名空间内的事件、工具和提示词段落，不能直接修改安全内核服务。
- 插件 manifest 声明的 `requiredPermissions` 仅是部署审批输入；运行时实际权限仍由能力经纪人逐次签发。
- 插件卸载必须撤销注册、停止后台任务、释放资源；不能删除会话事件或遗留无限期凭据。
- 插件接口采用语义化版本。对事件 schema 的破坏性变更要求新增版本和迁移器，不能静默改变历史事件含义。

### 9.2 Profile

Profile 是经审核的插件组合，例如：

| Profile | 适用场景 | 允许能力 |
| --- | --- | --- |
| `data-readonly` | 数据问答与已存在数据集分析 | 读取目录、受限查询、生成报告，不允许网络抓取或外部写入。 |
| `data-collector` | 用户已授权的数据抓取 | `data-readonly` + 指定连接/域名的抓取任务。 |
| `research-publisher` | 生成后人工确认发布 | `data-collector` + 待审批导出/通知。 |

Profile 不按用户自由上传的代码动态拼装；生产环境仅允许运维审核、签名和版本固定的 Bundle。

## 10. 需求与验收

| 编号 | 要求 | 验收证据 |
| --- | --- | --- |
| HR-01 | 运行时可替换模型、工具、记忆和数据源实现 | 以同一 Profile 分别接入两个模型适配器，不改 Agent loop。 |
| HR-02 | 会话可审计、暂停和恢复 | 模拟在工具执行中宕机，恢复后不重复创建外部资源。 |
| HR-03 | 工具必须经能力经纪人执行 | 直接调用工具适配器或伪造 ToolProposal 均被拒绝。 |
| HR-04 | A/B 租户在事件、关系库、对象、缓存、队列与向量检索上隔离 | 跨租户探针测试均无法读取、写入或推断目标资源。 |
| HR-05 | Secret 不进入持久事件、日志、提示词或 ToolResult | CI 对事件、日志和请求录制执行 Secret 扫描并通过。 |
| HR-06 | 可撤销连接与记忆 | 撤销后新 grant 失败；删除后主存储、向量、缓存与派生产物均清除。 |
| HR-07 | 插件不能扩大权限 | 安装一个声明网络/存储权限的测试插件，仍只能获得当前 grant 所授范围。 |
| HR-08 | 输出与成本受限 | 每 Turn 具有模型 token、工具调用、网络请求、并发和存储预算；超限产生可审计终止事件。 |

## 11. 明确边界与非目标

- Harness 管理 Agent 的生命周期和副作用协调，但**不**替代数据库 RLS、KMS、容器沙箱或云 IAM。
- 模型提供商决定文本生成，但**不**决定租户授权、数据可见性或工具执行权限。
- 工具 schema 校验参数形状，但**不**证明资源归属或操作安全。
- 提示词约束用于改善行为，但**不**是访问控制机制。
- 事件日志用于重放和审计，但持久化并不授权任意人员读取事件 payload。
- 初期不支持跨用户共享记忆、数据集或连接；未来共享能力必须引入独立的工作区成员模型、资源 ACL、显式同意和审计，不能复用个人租户默认授权。
- 不允许插件执行任意宿主代码、任意 shell、任意内网请求或全库扫描；这些能力若未来需要，必须通过独立隔离产品面提供。

## 12. 实施路径

### Phase 1：安全基础与可恢复会话

1. 实现 `ActorContext`、租户中间件、数据库 RLS、对象存储前缀策略和 KMS Secret 引用。
2. 建立 Session/Turn/Step 事件模型、投影和幂等工具结果。
3. 完成 `base-secure` Bundle 与能力经纪人，暂只提供只读数据目录工具。

### Phase 2：数据 Agent Profile

1. 增加模型适配器、提示词装配、租户记忆检索与数据分析工具。
2. 接入隔离 Worker、OAuth/API 连接以及抓取任务。
3. 增加预算、用户审批与完整的 A/B 租户回归测试。

### Phase 3：插件生态与治理

1. 发布受版本控制的插件 SDK、manifest 校验和 Bundle 签名流程。
2. 实现事件回放、诊断视图、用户数据导出/删除和 JIT 支持访问。
3. 按数据敏感等级演进为独立执行池、每租户密钥或独立数据库。

## 13. 上线门槛

生产启用某一 Profile 前必须确认：

1. 所有持久事件、数据记录、对象、缓存和向量均有不可为空的 `tenant_id`。
2. 生产运行账号不能绕过 RLS，Worker 无全局云凭据、共享浏览器状态或内网访问。
3. Agent 的每个工具调用都可关联到 `ToolProposal`、授权判定、`CapabilityGrant` 和最终结果事件。
4. Secret 扫描覆盖日志、事件、模型请求、错误上报与测试夹具，且无泄露。
5. 宕机恢复、重复投递、撤销连接、删除记忆和跨租户攻击测试已验证。
6. 所有生产插件已审核、固定版本并附带最小权限声明。

## 14. 参考资料

- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)：插件组合、Turn/Step 生命周期、持久事件与工具管线。
- [DeepSeek Harness Repository](https://github.com/deepseek-ai/deepseek-harness)：官方项目说明、开发者预览状态及 package 组织。
- [DeepSeek Harness 官方介绍](https://deepseek.com/harness/en/)：模型、工具、会话、沙箱、调度和 UI 可组合的产品定位。

