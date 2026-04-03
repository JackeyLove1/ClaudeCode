# Prompt 系统

这份文档回答一个更具体的问题：

这个仓库里的 “prompt 系统” 不是一段固定字符串，而是怎样被组装、缓存、注入、压缩，并最终发给模型的？

先说结论：

这里的 prompt 系统本质上是一个多层拼装管线，不只是 `system prompt`。
它至少包含 6 类内容：

- 默认 system prompt
- 运行时覆写/追加 prompt
- user context / system context
- 工具 schema 里的 tool prompt
- slash command / skill 扩展出来的 prompt
- compact / summary 等特殊场景 prompt

可以把它理解成：

```text
用户输入
-> processUserInput / slash command 展开
-> getSystemPrompt() 生成默认 system prompt 片段
-> buildEffectiveSystemPrompt() 或等价逻辑做最终合并
-> prependUserContext() / appendSystemContext()
-> toolToAPISchema() 注入工具 prompt
-> buildSystemPromptBlocks() 切成带 cache 语义的 API blocks
-> query() 发给模型
```

---

## 1. Prompt 系统由哪些层组成

### 1.1 默认 system prompt

默认 system prompt 的核心在 `src/constants/prompts.ts` 的 `getSystemPrompt()`。

它不是返回一个大字符串，而是返回 `string[]`，每个元素都是一个 section。这样做有两个直接收益：

- 方便按 section 缓存和增删
- 方便在 API 层按 block 切分，做 prompt cache

这层负责放入模型最基础的行为约束，例如：

- 身份与任务定位
- 工具使用原则
- 安全边界
- 输出风格
- 环境信息
- MCP 指令
- memory / scratchpad / proactive 等动态能力说明

### 1.2 运行时有效 system prompt

默认 prompt 还不是最终发给模型的 prompt。

真正的“有效 prompt”在两处形成：

- 交互主线程等路径：`src/utils/systemPrompt.ts` 的 `buildEffectiveSystemPrompt()`
- SDK / headless 路径：`src/QueryEngine.ts` 里直接按同样思路拼装

这一步处理：

- `overrideSystemPrompt`
- coordinator prompt
- agent prompt
- `customSystemPrompt`
- `appendSystemPrompt`

也就是说，仓库里没有唯一一个 prompt 文件，真正生效的是“默认 prompt + 运行时策略”的结果。

### 1.3 user context / system context

这部分在 `src/utils/queryContext.ts`、`src/utils/api.ts` 和 `src/query.ts`。

系统把 prompt 分成两种不同的上下文载体：

- `userContext`：通过 `prependUserContext()` 伪装成一个 meta user message，包在 `<system-reminder>` 里插到消息前面
- `systemContext`：通过 `appendSystemContext()` 直接追加到 system prompt 尾部

也就是说，仓库不把所有上下文都塞进 system prompt，而是区分：

- 哪些更像“用户可参考背景”
- 哪些更像“系统级环境补充”

### 1.4 工具 prompt

工具本身也是 prompt 系统的一部分。

在 `src/Tool.ts` 里，每个 `Tool` 不只有执行逻辑，还有：

- `prompt()`
- `description()`
- 输入 schema

而 `src/utils/api.ts` 的 `toolToAPISchema()` 会调用 `tool.prompt()`，把它变成 API 里的工具描述。

这意味着模型看到的不只是 “有一个工具叫 BashTool”，还会看到这个工具的使用说明，而这份说明也是 prompt。

### 1.5 slash command / skill prompt

仓库里很多 command 不是本地命令，而是 `type: 'prompt'` 的 prompt command。

相关逻辑在：

- `src/commands.ts`
- `src/utils/processUserInput/processSlashCommand.tsx`

这类命令在执行时会调用 `getPromptForCommand()`，把 `/commit`、`/brief`、skill 等展开成一段新的模型输入，并以 meta message 的形式插回消息流。

所以 skill 系统本质上也是 prompt 扩展系统。

### 1.6 compact prompt

当上下文过长时，系统会用另一套 prompt 要求模型“总结对话”。

这部分在：

- `src/services/compact/prompt.ts`
- `src/services/compact/compact.ts`

它不是沿用主对话 prompt，而是专门构造一段“只输出文本 summary、禁止调工具”的 compact prompt。

所以 compact 不是对消息做字符串裁剪，而是让模型在另一条 prompt 轨道上生产压缩摘要。

---

## 2. 默认 system prompt 是怎么生成的

### 2.1 `getSystemPrompt()` 返回的是分段结构

`src/constants/prompts.ts` 的 `getSystemPrompt()` 会按 section 组装 prompt，典型包含：

- intro
- system
- doing tasks
- actions
- using your tools
- tone and style
- output efficiency
- dynamic sections

这里最关键的设计不是内容本身，而是 “静态 section + 动态 section” 的拆分。

### 2.2 静态段和动态段被显式分界

文件里定义了：

```ts
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

这个 marker 很重要。

它告诉后面的 API 层：

- marker 之前的内容可以作为更稳定的静态前缀
- marker 之后的内容是动态 section，不应和静态前缀共享同一层 cache 语义

也就是说，这个仓库从设计上就把 “prompt 内容” 和 “prompt cache 命中率” 绑在一起考虑了。

### 2.3 动态 section 有自己的缓存层

`src/constants/systemPromptSections.ts` 提供了：

- `systemPromptSection()`
- `DANGEROUS_uncachedSystemPromptSection()`
- `resolveSystemPromptSections()`

普通 dynamic section 会在 session 内缓存，直到 `/clear` 或 `/compact` 清空。

这意味着很多“动态 section”其实不是每轮重算，而是“本 session 稳定”。

默认 dynamic section 里比较典型的有：

- session-specific guidance
- memory
- ant model override
- env info
- language
- output style
- scratchpad
- function result clearing

### 2.4 只有少数 section 被允许显式破坏 cache

最典型的是 MCP instructions。

在 `getSystemPrompt()` 里，它被放进 `DANGEROUS_uncachedSystemPromptSection()`，原因写得很直接：MCP server 可能在 turn 之间连接/断开。

这说明系统对 cache 稳定性是强约束：

- 默认 section 一律缓存
- 只有确实会在 turn 间变化、并且必须被模型看到的内容，才允许 cache-break

### 2.5 proactive 模式走的是另一条 prompt 分支

如果启用了 proactive / kairos，`getSystemPrompt()` 会直接走一条更短、更自治的 prompt 路径，而不是复用普通交互态的全部 sections。

这说明 prompt 系统不是“所有模式共享一个模板”，而是按运行模式分叉。

---

## 3. 最终有效 prompt 的优先级

`src/utils/systemPrompt.ts` 的 `buildEffectiveSystemPrompt()` 已经把优先级写得很清楚：

1. `overrideSystemPrompt`
2. coordinator system prompt
3. agent system prompt
4. `customSystemPrompt`
5. default system prompt

然后：

- `appendSystemPrompt` 一般总是追加在最后
- 但如果用了 `overrideSystemPrompt`，它直接替换全部内容

这里有两个细节很关键。

### 3.1 agent prompt 有时替换默认 prompt，有时追加

普通情况下，agent prompt 会替换默认 prompt。

但在 proactive 模式下，agent prompt 会被作为：

```text
# Custom Agent Instructions
...
```

追加到默认 prompt 后面。

也就是说，agent 在这个仓库里不是固定的“独立人格 prompt”，而是会随模式切换“替换式”或“增量式”合并。

### 3.2 SDK 路径会跳过部分默认上下文

`src/utils/queryContext.ts` 的 `fetchSystemPromptParts()` 有一个重要分支：

- 如果设置了 `customSystemPrompt`
  - 跳过 `getSystemPrompt()`
  - 跳过 `getSystemContext()`

`src/QueryEngine.ts` 还会在这种情况下，按需额外注入 `memoryMechanicsPrompt`。

这意味着 `customSystemPrompt` 在 SDK/headless 模式里不只是“覆盖默认文案”，而是会改变整条上下文装配路径。

---

## 4. Prompt 是怎样进入 query 主循环的

### 4.1 `fetchSystemPromptParts()` 先取三块前缀内容

`src/utils/queryContext.ts` 会先收集：

- `defaultSystemPrompt`
- `userContext`
- `systemContext`

这三者一起构成 API cache-key 前缀里的核心部分。

### 4.2 `processUserInput()` 会先把 slash command 展开

`src/utils/processUserInput/processUserInput.ts` 和 `processSlashCommand.tsx` 会先处理：

- 普通文本输入
- slash command
- skill
- attachment
- hook 注入

其中 prompt command 会被展开成新的 meta user message。

所以模型真正看到的 “用户输入”，很多时候已经不是原始键入文本，而是“扩展过的 prompt 流”。

### 4.3 `query.ts` 把三类上下文放到不同位置

`src/query.ts` 里有两行最关键：

```ts
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)

messages: prependUserContext(messagesForQuery, userContext)
```

也就是说：

- `systemContext` 被拼到 system prompt
- `userContext` 被伪装成一个前置 user message

这是 prompt 系统最重要的结构化分层之一。

### 4.4 发送 API 前还会再加工一遍 system prompt

到 `src/services/api/claude.ts`，system prompt 还会被继续处理：

- 加 attribution header
- 加 CLI sysprompt prefix
- 按 cache 规则拆 block
- 生成 Anthropic API 需要的 `TextBlockParam[]`

真正发给模型的并不是 `getSystemPrompt()` 的原始返回值，而是经过 API 层重排后的 block 集合。

---

## 5. 工具 prompt 系统：模型如何理解工具

### 5.1 工具 schema 不是静态 JSON，而是运行时生成

`src/utils/api.ts` 的 `toolToAPISchema()` 会把 `Tool` 转成 API schema。

这个过程至少会用到：

- `tool.name`
- `tool.prompt()`
- `tool.inputSchema` / `inputJSONSchema`
- `strict`
- `eager_input_streaming`
- `defer_loading`

因此，工具系统本身就是模型 prompt 的一部分，而不是仅仅运行时可调用能力。

### 5.2 `tool.prompt()` 结果会被 session 级缓存

`toolToAPISchema()` 会把 base schema 缓存在 `src/utils/toolSchemaCache.ts`。

缓存 key 通常是：

- `tool.name`
- 某些场景下再加 `inputJSONSchema`

原因很直接：工具 schema 在 system prompt 前面，一旦字节变化，就会打碎整个 prompt cache 前缀。

所以这里缓存的不是“为了省一点 CPU”，而是为了稳定 prompt bytes。

### 5.3 工具列表本身也为了 cache 稳定而排序

`src/utils/toolPool.ts` 的 `mergeAndFilterTools()` 明确把工具分成：

- built-in contiguous prefix
- MCP suffix

再按名字排序。

这不是美观问题，而是为了尽量避免：

- 某个 MCP 工具晚连接
- 某个工具被去重/过滤

时导致整段工具 schema 顺序抖动。

### 5.4 ToolSearch 本质上是“按需暴露 prompt”

当 tool search 启用时，`src/services/api/claude.ts` 会决定哪些工具带 `defer_loading`，哪些真正进本轮 schema。

所以这个系统不是一次性把所有工具 prompt 全塞给模型，而是支持：

- 先暴露一部分
- 其余工具延迟发现
- 被发现后再进入下一轮 prompt

从 prompt 系统视角看，这其实是“工具 prompt 的按需分页”。

---

## 6. Prompt cache 是这个系统的第一原则之一

这个仓库里很多设计看起来像工程细节，实质上都在服务 prompt cache。

### 6.1 system prompt 被拆成带 scope 的 block

`src/utils/api.ts` 的 `splitSysPromptPrefix()` 会把 system prompt 拆成不同 block，并打上：

- `global`
- `org`
- `null`

几种 cache scope。

当存在 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 时：

- boundary 前静态部分可以走更激进的 cache
- boundary 后动态部分单独处理

### 6.2 如果 MCP 工具真正出现在工具列表里，就不能安全做全局 system prompt cache

`src/services/api/claude.ts` 里有 `needsToolBasedCacheMarker`：

- 如果本轮会渲染 MCP tool schema
- 那么 system prompt 的全局缓存策略要收缩

因为 MCP 工具天然带用户态、连接态差异，不适合和全局静态 prompt 共用同一层缓存假设。

### 6.3 很多“不要动态变化”的约束都在保护 cache key

例如：

- tool schema session cache
- system prompt section cache
- built-in/MCP 工具分区排序
- dynamic boundary
- clear on `/compact` / `/clear`

所以理解这个仓库的 prompt 系统，不能只盯着文案内容，还要盯着“哪些字节必须稳定”。

---

## 7. Compact 与 Prompt Too Long 的处理

### 7.1 compact 本身也是一次单独的 prompt 任务

`src/services/compact/prompt.ts` 里专门定义了 compact prompt。

它会强调：

- 只能输出文本
- 不许调工具
- 要按固定结构总结历史

这说明 compact 不是 message 层机械裁剪，而是让模型执行一项新的“总结任务”。

### 7.2 如果 compact 自己也触发 prompt too long，不会直接失败

`src/services/compact/compact.ts` 会在 compact 请求本身遇到 PTL 时调用：

- `truncateHeadForPTLRetry()`

它会丢掉最旧的一批 API-round groups，再重试 compact。

也就是说，系统对 prompt 过长的处理是分层降级的：

- 先 normal query
- 再 auto/reactive compact
- 如果 compact 也过长，再做 head truncation retry

### 7.3 compact 后要恢复一些“非摘要状态”

compact 不是只留下 summary。

`src/services/compact/compact.ts` 还会恢复或保留：

- attachment
- hook 结果
- skill 内容
- plan mode / discovered tools 等元信息

这说明 prompt 系统维护的不只是对话文本，还有“让后续 prompt 继续可用的执行态”。

---

## 8. 这个仓库里的 prompt 系统本质是什么

可以把它总结成一句话：

这个仓库实现的不是 “一段 system prompt”，而是一套面向 agent runtime 的 prompt 装配系统。

它有几个鲜明特征：

- prompt 被拆成多层：system、context、tool、skill、compact
- prompt 不是一次性拼接，而是在不同阶段逐层注入
- prompt 内容设计和 cache 稳定性是同时设计的
- 工具描述本身也是 prompt
- slash command / skill 本质上也是 prompt 扩展
- compact 不是裁剪字符串，而是用另一条 prompt 链路做摘要重建

如果只看 `getSystemPrompt()`，只能看到这套系统的一部分。
真正完整的 prompt 链路，需要一起看：

- `src/constants/prompts.ts`
- `src/utils/systemPrompt.ts`
- `src/utils/queryContext.ts`
- `src/utils/api.ts`
- `src/query.ts`
- `src/services/api/claude.ts`
- `src/utils/processUserInput/processSlashCommand.tsx`
- `src/services/compact/prompt.ts`

---

## 9. 相关阅读

- [上下文预处理](./上下文预处理.md)
- [工具调用](./工具调用.md)
- [架构分析](./架构分析.md)
