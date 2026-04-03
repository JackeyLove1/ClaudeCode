# Plugin系统

## 1. 定位

如果说 Skill 解决的是“如何描述一种能力”，那么 Plugin 解决的是“如何把多种能力作为一个发行单元装进系统”。`src/utils/plugins/` 的职责不是只做安装，而是完整覆盖：

- 发现来源
- 拉取内容
- 校验 manifest
- 缓存版本
- 合并多来源插件
- 把插件组件注入到运行时

因此，Plugin 系统更接近 Claude Code 的本地生态分发层。

## 2. 插件能提供什么

从 `src/utils/plugins/schemas.ts` 与 `src/types/plugin.ts` 可以看到，插件不是只扩展命令。一个插件或 marketplace entry 可以声明的组件面包括：

- `commands`
- `agents`
- `skills`
- `hooks`
- `outputStyles`
- `settings`
- `mcpServers`
- `lspServers`

`LoadedPlugin` 结构里也保留了对应路径与缓存槽位，例如：

- `commandsPaths`
- `agentsPaths`
- `skillsPaths`
- `outputStylesPaths`
- `mcpServers`
- `lspServers`
- `hooksConfig`
- `settings`

这说明 Plugin 是“多组件封装单元”，而不是单一功能插件。

## 3. 来源、优先级与装配顺序

`pluginLoader.ts` 顶层注释已经把插件来源说得很清楚。当前系统主要处理三类来源：

- marketplace plugins
- session-only plugins，例如 `--plugin-dir`
- builtin plugins

真正的合并发生在 `mergePluginSources()` 与 `assemblePluginLoadResult()` 中，整体顺序是：

1. 加载 marketplace plugins
2. 加载 session-only plugins
3. 加载 builtin plugins
4. 做来源合并与覆盖处理
5. 做依赖校验与降级
6. 产出 enabled / disabled / errors

这里最关键的优先级规则是：

- `--plugin-dir` 这种 session 插件可以覆盖已安装插件
- 但 managed settings 锁定的插件不能被 session 插件覆盖
- builtin plugins 作为最后一层补充

也就是说，Plugin 系统不是简单拼接，而是带有策略优先级的合并器。

## 4. 拉取、缓存与版本化

Plugin 的工程复杂度主要集中在缓存策略上。

### 4.1 版本化缓存

`pluginLoader.ts` 为插件提供了 versioned cache 路径，格式上是：

```text
~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/
```

这样做的意义是把“插件名”与“插件版本”解耦，避免不同版本互相覆盖。

### 4.2 Seed Cache 与 Zip Cache

当前实现不只支持本地主缓存，还支持：

- seed cache：用于预置缓存或首启命中
- zip cache：把缓存内容压成 zip 作为规范格式

这些机制说明插件系统已经不是“下载到一个目录就完事”，而是朝更稳定的分发缓存体系演化。

### 4.3 多种远端来源

从 schema 可见，Plugin Source 支持的不只是相对路径，还包括多种远端来源，例如 git、github、npm、url 等。`pluginLoader.ts` 内部也有对应的：

- git clone
- npm 安装
- 目录复制
- 缓存命中与回退

这让 Plugin 成为统一的“来源适配层”。

## 5. manifest、marketplace 与校验

### 5.1 Manifest 负责描述组件面

插件自身通过 `plugin.json` 提供元数据与组件声明，重点包括：

- 名称、版本、作者、描述
- 依赖
- commands / agents / skills / hooks / outputStyles
- mcpServers / lspServers
- userConfig / channels

这一步描述的是“插件自身是什么”。

### 5.2 Marketplace Entry 负责分发信息

marketplace entry 则补充了另一层信息：

- 插件来源
- 类别与标签
- 严格模式
- 可补充部分 manifest 字段

这一步更接近“插件从哪里来、怎样被发现与安装”。

### 5.3 校验不是单点动作

Plugin 的校验分散在多个阶段：

- marketplace 名称与来源校验
- plugin source 校验
- manifest schema 校验
- 路径存在性校验
- 依赖满足性校验
- 组件读取错误收集

最终它们都通过 `PluginError` 统一进入错误模型，而不是靠零散字符串拼接来处理。

## 6. 运行时装配

Plugin 系统真正重要的，不是“下载成功”，而是“装进去以后系统怎样消费”。

### 6.1 Commands / Skills / Agents / Hooks

`loadPluginCommands.ts`、`loadPluginAgents.ts`、`loadPluginHooks.ts`、`loadPluginOutputStyles.ts` 等模块负责把插件声明的不同组件加载进各自子系统。

其中最关键的一点是：这些模块普遍依赖 `loadAllPluginsCacheOnly()`，也就是尽量复用同一份插件发现结果，避免启动过程因为插件刷新而重复走重型加载链路。

### 6.2 Settings 注入

`cachePluginSettings()` 会把启用插件导出的 settings 合并进同步缓存层。这样插件不仅能提供能力，还能影响运行时配置读取结果。

这让 Plugin 不只是“扩展功能”，还是“扩展配置层”。

### 6.3 失效刷新

`clearPluginCache()`、`refresh.ts` 等逻辑表明，Plugin 系统显式处理：

- 安装后刷新
- 市场变更后刷新
- 下游命令 / hooks / MCP / LSP 视图刷新

所以它更像一套有状态的装配基础设施，而不是一次性加载器。

## 7. 与 Skill 和 MCP 的接口面

Plugin 系统之所以属于“生态扩展”主章节，核心原因就在这里。

### 7.1 Plugin 向 Skill 系统输送能力

插件既可以提供 skill 目录，也可以提供额外 `skills` 路径。之后这些内容会被 Skill 加载链路转换成 `Command`，并进入 slash command 与 SkillTool 视图。

换句话说：

- Plugin 负责交付 skill 资产
- Skill 系统负责解释和建模这些资产

### 7.2 Plugin 向 MCP 系统输送能力

`src/utils/plugins/mcpPluginIntegration.ts` 专门负责从插件中提取 MCP servers。插件可以通过：

- `.mcp.json`
- manifest `mcpServers`
- MCPB / DXT bundle
- channel userConfig

把 MCP server 注入系统。随后这些 server 会进入 `src/services/mcp/config.ts` 的统一配置聚合链路。

### 7.3 Plugin 自己不是执行层

这一点很重要。Plugin 虽然能把很多东西带进来，但它本身不直接承担最终执行：

- skill 执行由命令/Skill 体系处理
- tool 调用由工具执行与权限体系处理
- MCP server 建连与调用由 MCP client 处理

所以 Plugin 的本质仍然是“分发与装配”，不是运行时执行总线。

## 8. 小结

Plugin 系统把生态扩展从“用户手动拷文件”提升成了“可发现、可安装、可缓存、可组合的分发机制”。它的真正价值不在某一个接口，而在于它把本地生态接入统一成一个中间层：

- 上游接 marketplace、git、npm、inline 目录等来源
- 中游做 manifest 校验、缓存与依赖管理
- 下游把 commands、skills、hooks、MCP、LSP 等组件送入各个运行子系统

因此，在 Claude Code 的扩展架构里，Plugin 是连接“分发世界”和“运行时世界”的桥梁。
