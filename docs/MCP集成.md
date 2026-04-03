# MCP集成

## 1. 定位

`src/services/mcp/` 不是一个单纯的“第三方连接器目录”，而是 Claude Code 对外部能力的运行时协议接入层。它做的事情可以概括成两部分：

- 配置汇总：决定有哪些 MCP server 应该进入系统
- 连接执行：真正建立 transport、处理 auth、拉取 tools / prompts / resources / skills，并执行调用

因此，MCP 集成是整个生态扩展体系里最接近“运行时总线”的一层。

## 2. 配置汇总层

配置汇总的主入口是 `src/services/mcp/config.ts`。

### 2.1 配置模型

`src/services/mcp/types.ts` 定义了 `McpServerConfig` 与 `ScopedMcpServerConfig`。当前支持的 transport / 配置类型包括：

- `stdio`
- `sse`
- `sse-ide`
- `http`
- `ws`
- `ws-ide`
- `sdk`
- `claudeai-proxy`

其中，对外文档通常只需要把 `stdio`、`sse`、`http`、`ws`、`sdk` 视为主要 transport；其余更偏内部接入或特化场景。

### 2.2 Scope 与来源

MCP 配置不是单一文件读取，而是多 scope 汇总。当前类型系统里的 scope 包括：

- `enterprise`
- `user`
- `project`
- `local`
- `dynamic`
- `claudeai`
- `managed`

在 `getClaudeCodeMcpConfigs()` 这条链路中，真正参与 Claude Code 本地配置聚合的重点来源是：

- enterprise
- user
- project
- local
- plugin dynamic

之后 `getAllMcpConfigs()` 还会继续把 claude.ai connectors 合并进来。

### 2.3 策略过滤

配置汇总阶段还会执行策略过滤：

- `allowedMcpServers`
- `deniedMcpServers`
- `allowManagedMcpServersOnly`

`config.ts` 中分别实现了名字、命令数组和 URL 模式级别的 allowlist / denylist 判断。这说明 MCP 的安全约束并不是只在建连时拦截，而是在配置进入系统前就开始过滤。

### 2.4 项目级审批与显式启停

对 project `.mcp.json` 中的 server，系统还会结合 `getProjectMcpServerStatus()` 判断其状态：

- `approved`
- `rejected`
- `pending`

此外，`isMcpServerDisabled()` 与 `setMcpServerEnabled()` 负责显式启停。也就是说，MCP server 的可见性并不是“配置存在就一定连接”，而是叠加了策略、审批与用户开关。

## 3. 插件提供的 MCP Server 如何并入

`src/utils/plugins/mcpPluginIntegration.ts` 是 Plugin 与 MCP 的接口层。

### 3.1 输入来源

插件可以通过几种方式提供 MCP server：

- 插件目录中的 `.mcp.json`
- manifest 中的 `mcpServers`
- MCPB / DXT bundle
- assistant-mode channels 上的 `userConfig`

### 3.2 环境变量与用户配置注入

`resolvePluginMcpEnvironment()` 会在插件 server 进入 MCP 总配置前做变量展开，主要处理：

- `${CLAUDE_PLUGIN_ROOT}`
- `${user_config.X}`
- 一般环境变量 `${VAR}`

同时还会为 stdio server 注入：

- `CLAUDE_PLUGIN_ROOT`
- `CLAUDE_PLUGIN_DATA`

这一步让插件 MCP server 具有“插件上下文感知”。

### 3.3 作用域前缀与去重

插件 server 被装配时会调用 `addPluginScopeToServers()`，统一加上类似 `plugin:<pluginName>:<serverName>` 的作用域前缀，并标记 `scope: 'dynamic'`。

之后 `config.ts` 还会对 plugin MCP servers 做去重，避免：

- 和手工配置的 server 重复
- 插件之间提供同一底层命令或 URL 的 server

因此 Plugin 提供 MCP server 时，不会直接无条件覆盖主配置，而是进入统一合并与去重规则。

## 4. 连接执行层

MCP 执行的主入口在 `src/services/mcp/client.ts`。

### 4.1 建连与 transport

client 层会基于不同配置选择不同 transport，例如：

- `StdioClientTransport`
- `SSEClientTransport`
- `StreamableHTTPClientTransport`
- WebSocket transport
- SDK control transport

这说明 MCP 集成不是面向单一协议实现，而是面向“多 transport 的统一客户端封装”。

### 4.2 连接状态模型

`types.ts` 中定义的 `MCPServerConnection` 不是简单“连上/没连上”二元状态，而是多态状态：

- `connected`
- `failed`
- `needs-auth`
- `pending`
- `disabled`

这个状态模型会被会话层、UI 层和 `/mcp` 命令共同消费。

### 4.3 建连后拉取的能力

建连成功后，MCP 客户端不会只拉取 tools，还会根据 server capabilities 拉取：

- tools
- prompts / commands
- resources
- skills

其中 skill 是 MCP 集成里最容易被忽略的一环。当前实现会在 prompts 或 resources 发生 `list_changed` 时，刷新相关缓存，并把新的 MCP skills 与 prompts 一起写回命令集合。

这说明 MCP 的输出不是“只为 Tool 层服务”，而是会回流到命令层与技能层。

## 5. 关键运行机制

### 5.1 OAuth 与 needs-auth

`client.ts` 对远程 server 的 auth 处理相当重。它显式区分：

- 已连接
- 需要认证
- 401 后的 token refresh
- 会话级 auth 缓存

遇到 401 或未授权状态时，server 会被标记为 `needs-auth`，并写入本地缓存，避免持续重试导致的噪音和延迟。

### 5.2 Session Expired 与自动恢复

对于 HTTP 类 MCP server，代码里单独识别了 session 失效场景，例如：

- 404 + JSON-RPC `-32001`
- “Connection closed” 派生错误

一旦识别，会清理连接缓存并要求下次工具调用重新建连。这说明 MCP 集成在设计上已经把“长连接会过期”视为常态，而不是异常边角。

### 5.3 Large Result 持久化与截断

当 MCP tool 返回结果过大时，`client.ts` 不会简单抛错，而是会：

- 估算内容大小
- 决定是否截断
- 必要时把内容持久化到文件
- 返回一段引导文本，提示后续如何读取

这一步把 MCP 大输出从“模型上下文风险”转成了“可回读的外部工件”。

### 5.4 URL Elicitation Retry

对 MCP 的 URL elicitation，`callMCPToolWithUrlElicitationRetry()` 会在检测到 `UrlElicitationRequired` 后：

- 调用 hook
- 或将请求送入 UI / SDK 交互层
- 等待用户完成
- 再重试工具调用

这体现出 MCP client 不是“盲目 RPC 转发器”，而是能和用户交互流程配合的协议适配器。

## 6. 与 Commands、Skills、Resources 的关系

MCP 集成的一个关键特点，是它同时影响多种运行时对象。

### 6.1 Tools

这是最直观的一层。MCP tool 会被包装为内部 `Tool`，供模型调用。

### 6.2 Commands

MCP prompts 会作为命令进入系统，命名规则通常是 `mcp__<server>__<prompt>`。`src/services/mcp/utils.ts` 里也专门区分了 MCP prompts 与 MCP skills 的名字模式与过滤逻辑。

### 6.3 Skills

MCP skills 则会被建模为 `loadedFrom === 'mcp'` 的 prompt commands，并进入 `mcp.commands`。之后：

- `commands.ts` 可以把它们筛出
- `attachments.ts` 会把它们并入 skill listing
- `SkillTool` 也会把它们和本地 skills 合并展示

所以，从用户和模型的视角看，MCP 并不只是“多了几个远端工具”，而是整个能力集合都可能因远端 server 而变化。

### 6.4 Resources

MCP resources 则以 `ServerResource` 形式进入资源视图，用于后续浏览、读取和引用。

## 7. 小结

MCP 集成在 Claude Code 中承担的是外部能力接入总线的角色。它并不只负责“连上一个 server”，而是把外部能力完整转换为内部运行时对象，并在这个过程中处理：

- 多 scope 配置聚合
- 策略过滤与审批
- 插件 server 注入
- transport 适配
- auth 与会话恢复
- tool / prompt / skill / resource 拉取
- 大结果处理与交互式重试

因此，在生态扩展三层里，MCP 是最靠近执行面的那一层；它把 Plugin 分发进来的 server，或者用户直接配置的 server，真正变成了会话可用能力。
