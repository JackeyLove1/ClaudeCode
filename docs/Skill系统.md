# Skill系统

## 1. 定位

`src/skills/` 这套机制的目标，不是单纯“加载一些 Markdown 文件”，而是把一段提示资产转成可运行时调度的 `Command`。这使 Skill 同时具有两层身份：

- 对模型来说，它是可被自动选择的能力说明。
- 对用户来说，它又可能表现为显式的 slash command。

因此，Skill 系统本质上是“提示工程资产化 + 命令建模”的结合体。

## 2. 三类来源

从当前源码看，Skill 至少有三类来源。

### 2.1 Bundled Skills

`src/skills/bundledSkills.ts` 定义了 `BundledSkillDefinition` 与注册表。bundled skill 不是从磁盘扫描出来的，而是在启动时通过代码注册：

- `registerBundledSkill()` 把定义转成 `Command`
- `getBundledSkills()` 返回注册后的内存列表
- `clearBundledSkills()` 主要用于测试

真正的初始化入口在 `src/skills/bundled/index.ts`。这里会调用一组 `registerXxxSkill()` 方法，把内置 skill 注册进系统。当前目录 `src/skills/bundled/` 下可以看到 17 个 bundled skill 相关文件，但并不代表 17 个能力都会在所有运行环境下暴露出来：

- 一部分受 `feature('...')` 控制
- 一部分受运行时可用性判断控制，例如 `shouldAutoEnableClaudeInChrome()`
- 个别 skill 自身还带 `isEnabled()` 回调

因此，bundled skill 是“代码内置 + 运行时显隐”的模式，而不是静态清单。

### 2.2 磁盘目录 Skills

`src/skills/loadSkillsDir.ts` 负责从磁盘目录加载 skills。它支持多种来源：

- managed / policy 路径
- 用户目录
- 当前项目及向上层级的 `.claude/skills`
- 通过 `--add-dir` 注入的附加目录
- 兼容旧版 `commands/` 目录中的 skill / command 形式

这里真正重要的不是“从哪里读文件”，而是这些来源最终都会被折叠成统一的 `Command` 对象，再参与后续去重和排序。

### 2.3 MCP Skills

Skill 系统还有一条远端来源。`src/services/mcp/client.ts` 和 `src/services/mcp/useManageMCPConnections.ts` 在 feature 打开时会拉取 MCP skills，并把它们和 MCP prompts 一起放进 `mcp.commands`。

随后，`src/commands.ts` 通过 `getMcpSkillCommands()` 专门筛出 `loadedFrom === 'mcp'` 的命令，使它们进入 Skill 视图与 SkillTool。

这意味着 Skill 并不限于本地文件系统；远端协议返回的 skill，也会被归一成同一种命令抽象。

## 3. 从 Markdown 到 Command

`loadSkillsDir.ts` 的核心价值，在于它把 skill 从“文本文件”变成“命令对象”。

### 3.1 frontmatter 解析

`parseSkillFrontmatterFields()` 会抽取一组共享字段，包括：

- `description`
- `allowed-tools`
- `argument-hint`
- `arguments`
- `when_to_use`
- `model`
- `disable-model-invocation`
- `user-invocable`
- `hooks`
- `context`
- `agent`
- `effort`
- `shell`

这些字段决定 Skill 在运行时如何暴露、能调用什么工具、适合何时触发，以及是否允许模型直接调用。

### 3.2 Command 构造

`createSkillCommand()` 则负责把解析结果组装成 `Command`。这里会统一处理：

- `name`
- `description`
- `argNames`
- `whenToUse`
- `source`
- `loadedFrom`
- `hooks`
- `skillRoot`
- `context`
- `agent`
- `paths`

同时，真正执行 `getPromptForCommand()` 时，还会继续做几件事：

- 参数替换
- `${CLAUDE_SKILL_DIR}` 与 `${CLAUDE_SESSION_ID}` 注入
- 非 MCP skill 的内联 shell 执行
- 为磁盘型 skill 自动加上 `Base directory for this skill: ...` 前缀

所以 Skill 不是“读取后原样返回文本”，而是一套带运行时预处理的 prompt command 构造器。

## 4. 动态加载能力

Skill 系统真正复杂的部分，在于它不是一次性扫描，而是会持续按上下文扩展。

### 4.1 多来源加载与去重

`getSkillDirCommands()` 会并行加载 managed、user、project、additional dirs 与 legacy commands，再按真实路径做去重。这里用 `realpath` 作为文件身份，目的是处理：

- 软链接
- 重叠父目录
- 同一文件被多路径访问

所以，Skill 系统不是简单“按名字覆盖”，而是先按物理文件身份消重，再进入命令层。

### 4.2 Conditional Skills

frontmatter 中的 `paths` 会把 skill 标记为 conditional skill。它不会在启动时立即暴露，而是先放进 `conditionalSkills`，等待文件操作触发。

`activateConditionalSkillsForPaths()` 会在文件路径匹配成功时，把这些 skill 激活到 `dynamicSkills` 中。这里用的是 gitignore 风格匹配，因此它更像“按工作区上下文自动启用的 skill”。

### 4.3 动态目录发现

`discoverSkillDirsForPaths()` 与 `addSkillDirectories()` 负责沿文件路径向上查找嵌套的 `.claude/skills`。这使 Skill 的作用域可以比项目根更细，表现为“离当前文件越近的 skill，优先级越高”。

这是一种很典型的上下文感知扩展机制。

## 5. Bundled Skill 的懒提取与安全写盘

`bundledSkills.ts` 里有一个容易被忽略但很关键的机制：bundled skill 可以携带额外参考文件，并在首次调用时懒提取到磁盘。

这部分处理包括：

- 为每个 skill 分配确定性的提取目录
- 以 Promise 方式做进程内单次提取
- 检查相对路径，阻止目录逃逸
- 使用安全写入标志和权限模式写文件

这里的目的，是让模型在运行 skill 时还能按需 `Read/Grep` 这些参考资产，同时尽量降低路径穿越和竞争写入风险。

## 6. 与 Commands、Plugin、MCP 的关系

Skill 系统虽然位于 `src/skills/`，但它并不自成孤岛。

### 6.1 与 Commands 的关系

`src/commands.ts` 会把以下内容一起汇总：

- `getBundledSkills()`
- `getSkillDirCommands()`
- `getPluginSkills()`
- `getBuiltinPluginSkillCommands()`

也就是说，Skill 最终是被命令系统消费的，而不是独立执行框架。

### 6.2 与 Plugin 的关系

插件可以提供 skill 目录或额外的 skills 路径，因此 Plugin 是 Skill 的一个上游分发渠道。插件解决“skill 从哪里来”，Skill 系统解决“skill 怎样变成命令对象”。

### 6.3 与 MCP 的关系

`src/skills/mcpSkillBuilders.ts` 把 `parseSkillFrontmatterFields()` 与 `createSkillCommand()` 注册出来，供 MCP skill 发现逻辑复用。这一点很重要，因为它保证了：

- 本地 skill 与 MCP skill 共享相同的建模语义
- 系统不会为远端 skill 维护一套平行的命令构造逻辑

所以，Skill 系统表面上看是在“加载 Markdown”，本质上是在提供一套统一的 prompt-command 规范。
