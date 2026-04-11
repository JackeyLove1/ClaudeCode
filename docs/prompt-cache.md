# Prompt Cache 机制

这份文档只回答一个问题：

这个仓库里，`prompt cache` 到底是怎么被设计、命中、保护、失效和观测的？

先说结论：

- 这里的 prompt cache 不是一个单点功能，而是一整套约束。
- 真正被当成“缓存键前缀”的，不只是 `system prompt`，还包括工具 schema、消息前缀、模型、thinking 配置，以及一部分 beta/header/body 参数。
- 很多看起来和 cache 无关的实现，其实都在服务“让发给模型的字节尽量稳定”。

## 1. 仓库把什么当成 cache key 的核心

`src/utils/forkedAgent.ts` 对共享父会话 cache 的要求写得最直接：

- `system prompt`
- tools
- model
- messages prefix
- thinking config

也就是说，这个仓库默认把 Anthropic 侧 prompt cache 理解成“前缀级缓存”，而不是“整次请求是否一样”的黑盒。

在此基础上，`src/services/api/promptCacheBreakDetection.ts` 又把下面这些也当成会影响服务端 cache 命中的因素去追踪：

- `cache_control` 的 `scope` / `ttl`
- beta headers
- fast mode / AFK / cache editing / thinking clear 这些 sticky header 状态
- `effort`
- `extra body params`
- global cache strategy

所以，这个项目里的“prompt cache”概念，实际比“system prompt 是否相同”更宽。

## 2. 系统 prompt 是如何为 cache 拆层的

核心入口是 `src/constants/prompts.ts` 的 `getSystemPrompt()`。

它不是返回一个大字符串，而是返回 `string[]`，然后交给 `src/utils/api.ts` 的 `splitSysPromptPrefix()` 和 `buildSystemPromptBlocks()` 再切成 API block。

这里最关键的设计有三层。

### 2.1 静态段和动态段被显式分开

`getSystemPrompt()` 在静态内容和动态内容之间插入了：

```ts
SYSTEM_PROMPT_DYNAMIC_BOUNDARY
```

它的语义是：

- boundary 之前的静态段，允许走更激进的 cache
- boundary 之后的动态段，不应被当成跨会话稳定前缀

这个 boundary 是 prompt cache 设计里的硬约束。`prompts.ts` 还明确写了“不要移动或删除”。

### 2.2 动态 section 不是每 turn 都重算

`src/constants/systemPromptSections.ts` 提供两类 section：

- `systemPromptSection()`：会缓存到 `bootstrap/state.ts` 的 `systemPromptSectionCache`
- `DANGEROUS_uncachedSystemPromptSection()`：每 turn 重算，值变化时会打碎 prompt cache

当前 `getSystemPrompt()` 里，绝大多数动态 section 都是缓存的，比如：

- `memory`
- `env_info_simple`
- `language`
- `output_style`
- `scratchpad`
- `frc`
- `token_budget`

真正被显式标成危险未缓存的，是 `mcp_instructions`，原因也写得很明确：MCP server 可能在 turn 之间连接或断开。

这说明这里的原则是：

- 默认先保 cache 稳定
- 只有确实必须每 turn 看见的新信息，才允许破坏 cache

### 2.3 `/clear` 和 `/compact` 会重置这层缓存

`clearSystemPromptSections()` 会清空 section cache，同时清掉 beta header latches。

`src/services/compact/postCompactCleanup.ts` 和 `src/commands/clear/caches.ts` 会在 compaction 或 clear 后调用这套清理逻辑。

所以 section cache 的生命周期大致是：

- 会话内稳定
- `/compact` 或 `/clear` 后重建

## 3. system prompt block 是怎么映射成 API cache_control 的

`src/utils/api.ts` 的 `splitSysPromptPrefix()` 定义了 3 种模式。

### 3.1 first-party + boundary 存在

这是最激进的路径：

- attribution header：`cacheScope = null`
- system prompt prefix：`cacheScope = null`
- boundary 前静态内容：`cacheScope = 'global'`
- boundary 后动态内容：`cacheScope = null`

对应到 `buildSystemPromptBlocks()` 后，只有静态块会带：

```ts
cache_control: getCacheControl({ scope: 'global', ... })
```

### 3.2 first-party，但当前工具池里有会实际渲染的 MCP 工具

`src/services/api/claude.ts` 会先算：

```ts
needsToolBasedCacheMarker =
  useGlobalCacheFeature &&
  filteredTools.some(t => t.isMcp === true && !willDefer(t))
```

语义是：

- MCP 工具是 per-user、会变的
- 如果它真的进了工具列表，就不能再把 system prompt 当成可全局稳定复用的前缀

这时 `buildSystemPromptBlocks()` 会带 `skipGlobalCacheForSystemPrompt: true`，`splitSysPromptPrefix()` 会退化成：

- attribution header：不缓存
- system prompt prefix：`org`
- 其他内容：`org`

注意一个细节：

- `src/services/api/logging.ts` / `promptCacheBreakDetection.ts` 的类型和注释里还保留了 `tool_based`
- 但当前 `src/services/api/claude.ts` 里实际写入的 `globalCacheStrategy` 只有 `system_prompt` 或 `none`

也就是说，代码语义上仍然承认“工具影响全局 cache 策略”，但当前日志枚举已经简化了。

### 3.3 其他情况

比如：

- 3P provider
- boundary 不存在

这时 system prompt 退回到 org 级 cache：

- prefix：`org`
- rest：`org`

### 3.4 这里对 block 数量是很谨慎的

`buildSystemPromptBlocks()` 上方有一句很重要的注释：

> Do not add any more blocks for caching or you will get a 400

说明这里不仅在做语义拆分，也在受 API 侧 `cache_control` block 数量限制约束。

## 4. message prefix 上还会再打一个 cache breakpoint

system prompt block 之外，`src/services/api/claude.ts` 的 `addCacheBreakpoints()` 还会在消息数组里再放一个 message-level 的 `cache_control`。

这是主链路里最重要的第二层 cache 标记。

### 4.1 只允许一个 message-level marker

函数注释写得很强：

- 每个请求只允许一个 message-level `cache_control`
- 否则底层 page/local-attention 的回收行为会变差

正常情况下，这个 marker 放在最后一条消息。

### 4.2 `skipCacheWrite` 会把 marker 前移一条

如果是 fire-and-forget 的 fork（例如 side question、prompt suggestion 一类），`skipCacheWrite = true` 时 marker 会移到倒数第二条消息。

目的不是为了改 cache key，而是：

- 继续复用已经共享的前缀
- 但不要把这个短命分支自己的尾巴写进新的 cache entry

### 4.3 user / assistant 的 marker 落点不完全一样

`userMessageToMessageParam()` / `assistantMessageToMessageParam()` 的策略是：

- 字符串内容：把整条消息包成单个 text block，并给这个 block 打 `cache_control`
- 数组内容：只给最后一个 content block 打 `cache_control`

assistant 还有额外约束：

- 不会把 marker 打在 `thinking`
- 不会打在 `redacted_thinking`
- `CONNECTOR_TEXT` 打开时，也不会打在 connector text block 上

这说明这里默认把“真正适合作为可复用前缀边界的可见内容块”与“thinking/特殊块”区分开了。

## 5. `cache_control` 的 scope / ttl 是怎么决定的

`src/services/api/claude.ts` 的 `getCacheControl()` 返回的基础结构是：

```ts
{ type: 'ephemeral' }
```

然后按条件再叠加：

- `ttl: '1h'`
- `scope: 'global'`

### 5.1 `global` scope 只在 first-party 打开

`src/utils/betas.ts` 的 `shouldUseGlobalCacheScope()` 要求：

- provider 必须是 `firstParty`
- 不能显式关闭 experimental betas

所以 global-scope prompt caching 在这个仓库里不是通用能力，而是 first-party 路径特化。

### 5.2 1h TTL 是按 querySource allowlist 决定的

`should1hCacheTTL()` 的条件有两层：

- 用户是否有资格拿 1h TTL
- 当前 `querySource` 是否命中 GrowthBook allowlist

还做了两个 session-stable latch：

- `promptCache1hEligible`
- `promptCache1hAllowlist`

原因都一样：避免中途 overage 或 GrowthBook 刷新把 TTL 从 `1h` 切回 `5m`，从而直接打碎 prompt cache。

### 5.3 fast / AFK / cache editing / thinking clear 都做了 sticky latch

`src/services/api/claude.ts` 在真正发请求前，会把这些 header 状态“粘住”：

- `afkModeHeaderLatched`
- `fastModeHeaderLatched`
- `cacheEditingHeaderLatched`
- `thinkingClearLatched`

这样做的目的是：

- 功能可以在运行时变化
- 但一旦某个会话已经把相关 header 发出去，就不要因为 UI toggle、冷却状态、GrowthBook 翻转而让 cache key 来回变

一个很典型的例子是 fast mode：

- header 会 sticky-on
- 真正的 `speed='fast'` body 参数仍然保持动态

也就是“保 cache key 稳定”和“保实时行为正确”被拆成两层处理。

## 6. tools 本身也是 prompt cache 的一部分

这里有几条非常硬的实现。

### 6.1 tool schema 会做 session 级缓存

`src/utils/api.ts` 的 `toolToAPISchema()` 会把 base schema 缓存到 `src/utils/toolSchemaCache.ts`。

代码注释直接说明原因：

- tools 位于 system prompt 之前
- tool schema 的任何字节变化，都会打碎后面整段 cached prefix

缓存的内容包括：

- `name`
- `description`
- `input_schema`
- `strict`
- `eager_input_streaming`

而 `defer_loading` / `cache_control` 这种 per-request 变化则只做 overlay，不回写缓存。

### 6.2 schema cache key 不是只按工具名

如果工具带 `inputJSONSchema`，cache key 会变成：

```ts
${tool.name}:${jsonStringify(tool.inputJSONSchema)}
```

原因是有些 `StructuredOutput` 风格工具名字相同，但 schema 不同；只按名字缓存会把旧 schema 错复用回来。

### 6.3 工具池排序是专门为了 cache 稳定

`src/tools.ts` 的 `assembleToolPool()` 做了两件事：

- built-in tools 按名字排序
- MCP tools 单独按名字排序，然后整体拼到 built-in 后面

注释写得很清楚：

- built-in 要保持连续前缀
- 不能让 MCP 工具夹进 built-in 中间
- 否则只要某个 MCP 工具的名字排序位置变化，就会导致后续所有工具的 cache key 整体漂移

### 6.4 有些工具 prompt 会被挪到 attachment，目的也是保 cache

比如 `src/tools/AgentTool/prompt.ts`：

- 当 agent list delta 打开时
- 可用 agent 列表不再内联到 AgentTool 的 prompt
- 而是改从 attachment 注入

理由也写得很直接：保持工具描述稳定，避免 tools block 因 agent/MCP/plugin 变化而频繁打碎 cache。

## 7. 这个仓库里有很多“看起来不是 cache，其实是在保 cache”的实现

下面这些都值得单独记住。

### 7.1 `getUserContext()` / `getSystemContext()` 是 memoized 的

`src/context.ts` 把两者都做成了 `memoize(...)`：

- `getSystemContext()` 包含 git status 和可选的 cache breaker
- `getUserContext()` 包含 `claudeMd` 和 `currentDate`

所以主交互路径下：

- 这些内容默认是“会话内稳定”的
- 不会每 turn 重新算出新字节

### 7.2 日期故意允许“轻微陈旧”

`src/constants/common.ts` 里：

- `getSessionStartDate = memoize(getLocalISODate)`

注释直接说了取舍：

- 午夜后日期可能陈旧
- 但比起让整个 prompt prefix 在午夜整体失效，这个代价更小

`src/memdir/memdir.ts` 也用了同样思路：

- memory prompt 里写的是 `YYYY/MM/DD` 路径模式
- 不直接内联“今天的真实路径”

### 7.3 attachment 头部会预计算，避免“3 days ago”变成“4 days ago”

`src/utils/attachments.ts` 对 memory attachment header 的说明很典型：

- 如果每次 render 时重新算相对时间
- 文本会跨 turn 发生字节变化
- 直接 bust prompt cache

所以这类 header 会在 attachment 创建时一次性算好。

### 7.4 settings 临时文件路径用内容哈希，不用随机 UUID

`src/main.tsx` 在处理 `--settings` 的 JSON 字符串时，不用随机临时文件名，而是用内容哈希路径。

原因是：

- settings 路径会进入 Bash 工具的 sandbox 描述
- 工具描述又会进入 API tools
- 如果每次子进程路径都变，tool schema 字节就变，cache 前缀也跟着失效

### 7.5 tool result 预算替换状态也要稳定

`src/utils/toolResultStorage.ts` 的 `ContentReplacementState` 不是单纯为了省 token。

它还有一个明确目标：

- 同一个 `tool_use_id` 进入预算替换后，后续命运必须固定
- preview 文本也必须固定
- fork 时还要 clone 这份状态

否则不同 turn / 不同 fork 对同一个 tool result 做出不同替换决策，就会让前缀字节不一致，导致 cache miss。

## 8. fork / subagent 是怎样复用父会话 prompt cache 的

这套机制几乎是仓库里第二重要的 prompt cache 场景。

### 8.1 共享 cache 用的是 `CacheSafeParams`

`src/utils/forkedAgent.ts` 的 `CacheSafeParams` 包含：

- `systemPrompt`
- `userContext`
- `systemContext`
- `toolUseContext`
- `forkContextMessages`

这就是 fork 子任务时要尽量保持 byte-identical 的那部分。

### 8.2 thinking config 也必须一致

`forkedAgent.ts` 特别强调：

- thinking config 是 cache key 的一部分
- 如果 fork 设置了不同的 `maxOutputTokens`
- `claude.ts` 里会因此 clamp `budget_tokens`
- thinking config 就变了
- cache sharing 也就失效了

所以很多 fork 调用都反复强调：

- 不要改 `model`
- 不要改 `tools`
- 不要改 `thinking`
- 不要改 `effort`
- 不要改 `maxOutputTokens`

### 8.3 “禁用工具”也不能通过改工具列表来做

很多 fork 场景都会这么写：

- 保留和父会话一样的 tools
- 通过 `canUseTool` 回调把工具 deny 掉

而不是直接把 `tools: []` 传给 fork。

原因只有一个：tools 是 cache key 的一部分。

### 8.4 stop hooks 会保存一份最近的 cache-safe 快照

`src/query/stopHooks.ts` 在主线程和 SDK 路径下会：

- `saveCacheSafeParams(createCacheSafeParams(stopHookContext))`

这样 `/btw`、prompt suggestion、一些后台 fork 就能直接借用最后一次主线程请求的前缀，而不必自己重构。

### 8.5 `forkSubagent.ts` 连“子任务占位 tool_result”都做成了同字节

`src/tools/AgentTool/forkSubagent.ts` 的做法很极端，但非常符合这个仓库的思路：

- 保留完整父 assistant message
- 为所有 tool_use block 生成相同的 placeholder tool_result
- 只让最后那段 directive 文本因 child 而异

目的就是最大化 fork children 之间的共享前缀。

## 9. cached microcompact / cache editing 是 prompt cache 的另一条主线

这部分主要在：

- `src/services/compact/microCompact.ts`
- `src/services/api/claude.ts`
- `src/query.ts`

### 9.1 `query()` 里，microcompact 在 autocompact 之前

执行顺序是：

- `snip`
- `microcompact`
- `context collapse`
- `autocompact`

其中 cached microcompact 的目标不是“本地改消息”，而是“尽量不改前缀内容，同时让服务端删掉老 tool result 的缓存内容”。

### 9.2 cached microcompact 不直接改本地消息

`microCompact.ts` 里写得很明白：

- 它不会直接修改本地 message content
- 它只会登记 tool result
- 然后产出 `pendingCacheEdits`

真正的 `cache_edits` / `cache_reference` 注入发生在 API 层的 `addCacheBreakpoints()`。

### 9.3 API 层会把 `cache_edits` 插回固定位置并持久复用

`addCacheBreakpoints()` 做了几件关键事情：

- 先把历史 pinned `cache_edits` 按原位置重新插回去
- 再把这次新的 `cache_edits` 插进最后一个 user message
- 对删除引用做去重
- 然后把新的 block pin 住，保证后续请求还能在同样位置重发

这说明 cached microcompact 不是一次性 patch，而是“缓存删除指令本身也变成前缀的一部分，需要稳定重放”。

### 9.4 `cache_reference` 只会加在最后 cache marker 之前的 tool_result 上

同一个函数还会把：

```ts
cache_reference: block.tool_use_id
```

加到位于最后 `cache_control` 之前的 `tool_result` block 上。

注释里还特别说明了为什么用“严格在前面”，而不是“前面或同位置”：

- 避免 `cache_edits` 插入后产生 block index 边界问题

### 9.5 boundary message 要等 API 返回后再发

`src/query.ts` 不会在 microcompact 当下就立刻发 `microcompact_boundary`。

它会等 API 响应回来后，用真实的：

- `cache_deleted_input_tokens`

减去前一个基线值，算出本次真正删掉了多少 cached token，再生成边界消息。

这比客户端本地估算更准确。

### 9.6 如果 cache 大概率已经过期，就不用 cache editing 了

`microCompact.ts` 还有一条 time-based path：

- 如果距离上一次主线程 assistant 消息已经超过阈值
- 说明服务端 cache 很可能已经冷掉
- 这时就直接内容清空老 tool result

因为：

- 反正前缀已经要重写
- 与其保持旧内容，不如提前缩小即将被重写的 prompt

触发后还会：

- `resetMicrocompactState()`
- `notifyCacheDeletion(querySource)`

避免 cached MC 状态和 cache break 检测出现误报。

### 9.7 ant-only 的内部状态机在这份 checkout 里不可见

当前仓库里能看到这些动态导入：

- `src/services/compact/cachedMicrocompact.js`
- `src/services/compact/cachedMCConfig.js`

但实际文件不在这份 checkout 里。

因此当前能从代码里直接确认的是“外部契约”：

- 存在 `pendingCacheEdits`
- 存在 `pinnedEdits`
- 有 `triggerThreshold` / `keepRecent` / `supportedModels`
- 有 tool result 注册、删除候选选择、cache edit block 创建这套流程

但“具体删除算法”和“具体配置来源”在当前可见代码里是缺失的。

## 10. API context management 也在服务 prompt cache

`src/services/compact/apiMicrocompact.ts` 提供了 server-side `context_management` 策略。

它做的事情有两类：

- 清理 thinking
- 清理部分 tool uses / tool inputs

和 prompt cache 最相关的是 thinking 清理：

- 如果 `thinkingClearLatched` 变成 true
- `getAPIContextManagement()` 就会把旧 thinking turn 清到只剩 1 个

触发条件是：

- `src/services/api/claude.ts`
- 距离上次成功 API completion 超过 `CACHE_TTL_1HOUR_MS`

逻辑含义是：

- 既然 1h cache 已经确定失效
- 继续保留大量旧 thinking 已经没有 cache hit 价值
- 那就顺手把 thinking 也压掉

## 11. prompt cache 的观测与失效检测

### 11.1 使用量会单独记录 cache read / cache write / cache delete

`claude.ts` 的 usage 更新和累加，会追踪：

- `cache_read_input_tokens`
- `cache_creation_input_tokens`
- `cache_deleted_input_tokens`

`cost-tracker.ts` 也会把这些分别计入：

- per-model usage
- session total
- token counter metrics

所以这里不是只关心“命中没命中”，而是关心：

- 读了多少 cache
- 写了多少 cache
- cache editing 实际删了多少 token

### 11.2 失效检测是“两阶段”的

`src/services/api/promptCacheBreakDetection.ts` 的流程是：

1. 请求前 `recordPromptState(snapshot)`
2. 响应后 `checkResponseForCacheBreak(...)`

第一阶段记录：

- system hash
- tools hash
- 含 `cache_control` 的 hash
- betas
- effort
- extra body
- global cache strategy
- fast/auto/cachedMC 等状态

第二阶段看：

- `cache_read_input_tokens` 是否相较上一轮下降超过 5%
- 绝对下降值是否超过 2000 token

满足才认为是真的 cache break。

### 11.3 检测器会主动避开几类误报

它会显式跳过或降权这些情况：

- 首次调用
- haiku
- cached microcompact 刚做过 `cache_edits`
- compaction 之后
- 间隔超过 5min / 1h 的 TTL 过期

如果 prompt 没变、时间又没超 TTL，它甚至会把原因归到：

- `likely server-side (prompt unchanged, <5min gap)`

说明这个检测器并不假设“所有 miss 都是客户端问题”。

### 11.4 还会落 diff 文件

如果检测到 break，代码会把前后 prompt/tool 状态写成 diff 文件，方便调试。

## 12. 哪些操作会重置 prompt cache 相关状态

### 12.1 `/clear`

`src/commands/clear/caches.ts` 会清掉：

- prompt cache break detection state
- system prompt injection
- last emitted date
- post-compact cleanup 涉及的 section cache / microcompact state / beta latches

### 12.2 `/compact` 或 auto-compact 后清理

`runPostCompactCleanup()` 会清掉：

- microcompact state
- main-thread 的 `getUserContext()` memo cache
- system prompt section cache
- classifier approvals
- speculative checks
- beta tracing state

所以 compaction 在这里不仅是“消息摘要”，也是 prompt 相关状态的边界点。

## 13. 当前 checkout 里还留着哪些“cache 相关但没完整开放”的接口

### 13.1 `break-cache` 命令在当前 checkout 是 stub

`src/commands/break-cache/index.js` 当前只有：

```js
export default { isEnabled: () => false, isHidden: true, name: 'stub' };
```

但 `src/context.ts` 里仍然保留了：

- `systemPromptInjection`
- `setSystemPromptInjection()`

并且切换它会立即清掉 `getUserContext()` / `getSystemContext()` 的 memo cache。

所以“手动 cache break”的接线仍在，但当前公开 checkout 没有对应的真实命令实现。

### 13.2 cached microcompact 的内部实现文件缺失

前面提到的 `cachedMicrocompact.js` / `cachedMCConfig.js` 也属于这类情况：

- 对外接口在当前代码里可见
- 但具体内部策略不在当前仓库

## 14. 总结

如果把这套代码压缩成一句话，可以这么理解：

这个仓库把 prompt cache 当成一等约束，所以它不是“开了 `cache_control` 就结束”，而是从 system prompt 分段、tool schema 稳定、消息级 marker、fork 共享、microcompact/cache editing、TTL/header latch、到失效检测与清理，全链路都在围绕“尽量让可复用前缀的字节稳定”来设计。

反过来说，阅读这个仓库时，凡是看到下面这些词，基本都可以把它们理解成 prompt cache 设计的一部分：

- memoize
- stable / latched / sticky
- byte-identical
- rendered bytes
- do not change tools/model/thinking
- move to attachment
- hash-based path
- preserve prefix
- cache-safe params
