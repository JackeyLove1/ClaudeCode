# Agent Loop 主循环：src/query.ts 如何驱动一次完整 Agent 回合

这篇文档只回答一个问题：

`src/query.ts` 是怎样把“上下文预处理、模型流式采样、工具执行、恢复重试、stop hooks、预算控制、下一轮继续”串成一个完整 agent loop 的？

先给结论：

它不是一个“模型返回了 `tool_use` 就递归再调一次”的轻量封装，而是一个显式的状态循环。每一轮都会经历：

```text
准备本轮状态
  -> 请求前预处理上下文
  -> 调用模型并流式接收 assistant 输出
  -> 判断是否需要恢复 / 是否需要工具跟进
  -> 执行工具并回写 tool_result / attachment
  -> 注入额外上下文与预算控制
  -> 决定继续下一轮还是终止
```

因此，把 `query.ts` 理解成“模型调用器”是不够的。更准确的说法是：

- `query.ts` 是会话级 agent runtime 的主循环
- 它维护的是一个跨多轮迭代的显式状态机
- 工具调用只是其中一个分支，不是全部

## 1. `query()` 与 `queryLoop()` 的职责分工

对外暴露的是 `query(params)`，但真正的主循环在 `queryLoop(params, consumedCommandUuids)`。

两者职责分得很清楚：

- `query()` 是外层包装器
- `queryLoop()` 是实际执行每一轮 agent 回合的主体

### 1.1 `query()` 做什么

`query()` 本身非常薄，核心逻辑只有两件事：

1. 创建 `consumedCommandUuids`
2. `yield* queryLoop(...)`

只有当 `queryLoop()` 正常返回时，`query()` 才会补发这批命令的 `notifyCommandLifecycle(uuid, 'completed')`。  
这意味着：

- 如果 `queryLoop()` 抛错，completed 不会被补发
- 如果 generator 被外部 `.return()` 提前关闭，也不会走到这个补发逻辑

所以 `query()` 更像“生命周期收尾包装层”，不是实际的 agent loop。

### 1.2 `queryLoop()` 做什么

`queryLoop()` 才是完整闭环：

1. 初始化跨轮状态
2. 在 `while (true)` 中一轮轮推进
3. 在不同条件下 `continue` 到下一轮
4. 在终止条件满足时 `return` 一个 terminal reason

这里最关键的一点是：它没有把“继续下一轮”编码成函数递归，而是编码成显式状态迁移。  
这使得恢复路径、预算续轮、stop hook 重试、compact 后重试都能共享同一个循环框架。

## 2. 循环状态模型：这是显式状态机，不是递归套娃

`queryLoop()` 在入口定义了一个 `State`，并把它保存在局部变量 `state` 里。每一轮循环开始时先解构状态，再根据本轮结果构造下一个 `state`。

核心字段如下：

| 字段 | 作用 |
| --- | --- |
| `messages` | 当前这轮看到的会话消息基线。每次继续下一轮时，都会把 assistant 输出、tool result、attachment 等并回这里。 |
| `toolUseContext` | 工具运行时上下文，包含工具列表、app state、abortController、agent 信息、MCP 信息等。 |
| `autoCompactTracking` | 记录最近一次 compact 后的追踪信息，避免 compact 行为失控，也为统计和后续轮次提供上下文。 |
| `maxOutputTokensRecoveryCount` | 记录本轮因 `max_output_tokens` 已经恢复过几次，用于限制自动续写次数。 |
| `hasAttemptedReactiveCompact` | 标记这一轮是否已经试过 reactive compact，防止 prompt-too-long / media error 场景反复压缩重试。 |
| `maxOutputTokensOverride` | 在 `max_output_tokens` 触发时，临时把输出上限从默认值提升到更高额度。 |
| `pendingToolUseSummary` | 上一轮工具批次的摘要 Promise，本轮开始时再异步消费，避免阻塞下一次采样。 |
| `stopHookActive` | 标记 stop hook 阻塞错误是否已经触发过，用于 stop hook 重试路径。 |
| `turnCount` | 当前已经推进到第几轮内部回合，用来做 `maxTurns` 判断。 |
| `transition` | 上一轮为什么继续。它不参与主逻辑计算，但对恢复路径非常关键。 |

### 2.1 为什么 `transition` 很重要

`transition` 是这份实现里很容易被忽略、但非常关键的一个字段。它显式记录“上一轮是因为什么继续的”，例如：

- `collapse_drain_retry`
- `reactive_compact_retry`
- `max_output_tokens_escalate`
- `max_output_tokens_recovery`
- `stop_hook_blocking`
- `token_budget_continuation`
- `next_turn`

这让主循环不仅知道“要继续”，还知道“为什么继续”。  
例如 `prompt too long` 恢复时，会先尝试 context collapse drain；如果上一轮已经因为 `collapse_drain_retry` 继续过，这一轮就不会重复 drain，而是直接落到下一层恢复逻辑。

### 2.2 这套状态模型解决了什么问题

它本质上解决的是：一次用户 turn 并不总是“请求一次模型 -> 得到一次回答 -> 结束”。

在这个项目里，一次 turn 可能会被延长成很多个内部子轮次，因为系统可能需要：

- 继续执行工具
- 在 compact 后重试
- 在 output token 截断后续写
- 在 stop hook 阻塞后追加 meta message 再重试
- 在 token budget 认为还有必要时继续推进

所以 `State` 不是普通缓存，而是整个 agent loop 的控制平面。

## 3. 每轮请求前的预处理链

每轮真正调用模型之前，`query.ts` 都会先重建一份 `messagesForQuery`，然后沿着固定顺序对上下文做预处理。

顺序大致如下：

```text
messages
  -> getMessagesAfterCompactBoundary()
  -> applyToolResultBudget()
  -> HISTORY_SNIP（可选）
  -> microcompact
  -> CONTEXT_COLLAPSE（可选）
  -> autocompact
  -> 调用模型
```

这条链路非常重要，因为它说明“agent loop 的第一步不是问模型”，而是先整理模型即将看到的上下文。

### 3.1 `getMessagesAfterCompactBoundary()`

每一轮先从 `state.messages` 中只截取最后一个 compact 边界之后的活跃消息段。  
这样后续所有处理都围绕当前上下文段展开，不会反复把已经被摘要过的旧历史再送进来。

### 3.2 `applyToolResultBudget()`

在真正 compact 之前，先控制单条工具结果的体积。  
这一层做的是“工具结果预算裁剪”，不是语义摘要。目标是避免极端长的 `tool_result` 把当前轮上下文直接撑爆。

这里还有一个细节：某些 query source 会把 content replacement 记录持久化下来，方便 agent resume 或主线程恢复时复用。

### 3.3 `HISTORY_SNIP`

若功能开启，会先做 snip，把低价值历史从模型可见视图里移除，但不等于把 UI 上的完整历史全部删掉。  
snip 还会返回 `snipTokensFreed`，后面的 autocompact 阈值判断会把这部分收益算进去。

### 3.4 `microcompact`

这是完整 autocompact 之前的轻量减负层。  
这里的核心思想不是“总结上下文”，而是优先处理高成本工具结果，例如：

- 用 cache edits 删除旧工具结果缓存
- 或在必要时清空老工具结果正文

因此 microcompact 更像是“削峰”，而不是“摘要”。

### 3.5 `CONTEXT_COLLAPSE`

如果启用 context collapse，会先把部分历史折叠为投影视图。  
它在 autocompact 之前执行，是因为如果 collapse 已经把上下文压到安全区间，就没必要再做一次更激进的 summary compact。

这一层的重点不是直接向 transcript 里插入新消息，而是调整“本轮 query 实际看到的上下文视图”。

### 3.6 `autocompact`

最后才轮到完整自动压缩。  
如果 autocompact 成功，`query.ts` 会：

- 记录 compact telemetry
- 必要时更新 `taskBudgetRemaining`
- 重置 compact tracking
- 生成 `postCompactMessages`
- 立刻 `yield` 这些 compact 结果消息
- 然后用 compact 之后的新消息作为本轮真正送入模型的输入

这意味着 compact 不一定发生在某一轮结束之后，它也可能直接嵌在这一轮请求的前半段。

## 4. 模型采样与流式阶段

完成预处理后，主循环才会真正调用模型。  
这里不是简单 `await` 一个完整 response，而是进入流式消费阶段。

### 4.1 `deps.callModel()` 会携带哪些信息

调用模型时，`query.ts` 会显式带上当前轮所需的采样参数和运行上下文，包括：

- `messages: prependUserContext(messagesForQuery, userContext)`
- `systemPrompt: fullSystemPrompt`
- `thinkingConfig`
- `tools: toolUseContext.options.tools`
- `model: currentModel`
- `fallbackModel`
- `querySource`
- `agents` / `allowedAgentTypes`
- `maxOutputTokensOverride`
- `mcpTools`
- `effortValue`
- `advisorModel`
- `taskBudget`

这说明 query loop 不是只负责消息收发，它同时也是“本轮模型采样参数的最终装配层”。

### 4.2 流式处理中维护哪些本轮局部变量

每轮在真正 streaming 前会初始化：

- `assistantMessages`
- `toolResults`
- `toolUseBlocks`
- `needsFollowUp`

它们分别对应：

- 本轮 assistant 实际产出的消息
- 本轮工具执行后要回写的 user / attachment 结果
- 本轮发现的所有 `tool_use`
- 本轮是否需要在 assistant 输出后继续跟进

其中 `needsFollowUp` 非常关键。  
它是“这一轮是否进入工具分支”的唯一信号。如果 streaming 结束后它还是 `false`，流程会走“无工具分支”的收尾与恢复逻辑。

### 4.3 streaming fallback 与 tombstone

模型 streaming 期间如果触发 fallback，当前已经收集到的 assistant partial message 不能直接继续使用。  
`query.ts` 会：

- 为已产生的 assistant partial message 发出 tombstone
- 清空 `assistantMessages` / `toolResults` / `toolUseBlocks`
- 重建 `StreamingToolExecutor`
- 切换到 fallback model 重试整个请求

这里 tombstone 的作用是把前一次 streaming 尝试的半成品从 UI 和 transcript 中清掉，避免后续 thinking block 签名不合法。

### 4.4 withheld error：先不立刻暴露错误

在 streaming 过程中，如果出现某些可恢复错误，`query.ts` 不会马上把它们作为最终结果暴露出去，而是先“压住”：

- prompt too long
- media size error
- max_output_tokens

原因是这些错误后面仍然可能被恢复逻辑吃掉。如果太早把错误抛给上层，外部调用方可能会以为 turn 已经失败并提前结束监听。

所以这里形成了一个很重要的设计：

- streaming 阶段负责记录错误
- streaming 结束后的恢复分支负责决定“继续救”还是“正式对外暴露”

## 5. 无工具分支的收尾与恢复

如果本轮没有发现 `tool_use`，并不意味着立刻结束。  
此时主循环会进入“无工具分支”的后半段逻辑，这里同样可能继续下一轮。

### 5.1 `prompt too long` 的恢复链

当最后一条 assistant 消息是被 withheld 的 413 错误时，恢复路径是：

```text
prompt too long
  -> 先尝试 context collapse drain
  -> 仍不行则尝试 reactive compact
  -> 还不行才正式暴露错误并返回
```

这里有两个关键点：

1. `collapse drain` 比 reactive compact 更轻，优先级更高
2. `hasAttemptedReactiveCompact` 和 `transition.reason` 会一起防止重复重试

因此这不是“报错后简单重试一次”，而是多层恢复策略。

### 5.2 `max_output_tokens` 的恢复链

如果最后一条 assistant 消息是 `max_output_tokens`，恢复分两层：

```text
max_output_tokens
  -> 若当前还没 override，先把输出上限提升到更高额度再重试
  -> 若还会截断，则插入一条 meta recovery message 继续下一轮
  -> 超过恢复上限后才真正把错误暴露出来
```

那条 recovery message 的作用很明确：要求模型直接续写，不要道歉，不要 recap，而是从被截断处继续往下做。

### 5.3 API error 会提前终止 stop hooks

如果最终 assistant 消息本质上仍是 API error，那么 `query.ts` 会直接返回，不再执行正常 stop hooks 判定。  
原因也很明确：模型并没有产出一条“有效回答”，这时再让 stop hooks 去评估它，只会制造新的死循环。

### 5.4 `handleStopHooks()` 也可能让循环继续

当没有工具调用且没有提前终止时，主循环会执行 `handleStopHooks(...)`。  
它可能产生三类结果：

- `preventContinuation`
- `blockingErrors`
- 正常通过

其中最容易忽略的是 `blockingErrors`。  
一旦存在，`query.ts` 会把这些 blocking error 包装成新的 user/meta message 并回写进 `state.messages`，然后 `continue` 到下一轮。  
换句话说：

- 没有 `tool_use`
- 没有用户新输入
- 仍然可能因为 stop hook 阻塞而继续下一轮

### 5.5 `TOKEN_BUDGET` 也可能主动续轮

stop hooks 之后，如果 `TOKEN_BUDGET` 开启，`query.ts` 会调用 `checkTokenBudget(...)`。  
预算模块可能返回 `continue`，这时循环会：

- 记录 continuation count
- 生成一条 meta nudge message
- 把它拼回 `messages`
- 再继续下一轮

所以“没有 tool_use 不代表 turn 结束”这个判断，在这里再次成立。

## 6. 有工具分支的执行与续轮

如果 streaming 阶段捕获到了 `tool_use`，就会进入工具执行分支。

### 6.1 两条工具执行路径

当前实现支持两种路径：

- `StreamingToolExecutor`
- `runTools(...)`

前者用于边 streaming 边完成部分工具执行；后者是传统的批处理执行入口。

所以工具不是一定要在 assistant 全部输出完后才统一跑完。  
如果 streaming tool execution 打开，一部分工具结果可以更早完成并提前进入 transcript。

### 6.2 工具执行如何回写

不管是哪条路径，主循环都会消费 `toolUpdates`。每个 update 可能带：

- `message`
- `newContext`

如果有 `message`：

- 立刻 `yield`
- 再通过 `normalizeMessagesForAPI()` 转成 API 可接受的 user 消息
- 推入 `toolResults`

如果有 `newContext`：

- 用它更新 `updatedToolUseContext`

这说明工具执行不仅会产出 `tool_result`，也可能直接修改后续轮次看到的 runtime context。

### 6.3 tool use summary 是异步挂到下一轮的

工具批次执行完后，主循环可能异步触发 `generateToolUseSummary(...)`。  
这个摘要不会阻塞当前轮，而是存进 `nextPendingToolUseSummary`，等下一轮开始时再消费并 `yield`。

这是一种很典型的“把非关键路径工作藏在下一轮空档里”的设计。

### 6.4 attachment 注入是工具分支的重要后处理

工具执行后，`query.ts` 还会补一整层 attachment 注入：

- queued command snapshot 转 attachment
- memory prefetch consume
- skill discovery prefetch consume

这些内容都会被追加到 `toolResults`。  
因此下一轮模型看到的并不只有 assistant + tool_result，还可能看到系统额外注入的 attachment。

### 6.5 为什么 `Sleep` 会影响 queued command drain

代码里会检查本轮工具中是否跑过 `SleepTool`。  
如果跑过 sleep，队列里的命令会以更保守的优先级被 drain。这个细节反映的是：某些工具会改变“后台通知什么时候适合送进下一轮上下文”的时机策略。

### 6.6 进入下一轮前还会刷新工具集合

如果 `refreshTools()` 存在，主循环会在续轮前重新刷新一次工具列表。  
这样新连接上的 MCP server 或动态变化的工具池，就能在下一轮立即对模型可见。

### 6.7 最后的续轮写回

当工具执行和附件注入完成后，主循环会检查：

- 是否 abort
- 是否被 hook attachment 阻止继续
- 是否超过 `maxTurns`

如果都没有触发终止，它会构造新的 `State`：

- `messages = [...messagesForQuery, ...assistantMessages, ...toolResults]`
- `toolUseContext = toolUseContextWithQueryTracking`
- `pendingToolUseSummary = nextPendingToolUseSummary`
- `turnCount = turnCount + 1`
- `transition = { reason: 'next_turn' }`

然后回到 `while (true)` 顶部，开始下一轮。

### 6.8 三类“继续下一轮”的原因

从整个实现看，继续下一轮大致有三类原因：

| 类别 | 触发条件 | 典型例子 |
| --- | --- | --- |
| 模型要求继续 | 模型显式产生 `tool_use` | assistant 请求调用 Bash、FileEdit、MCP Tool |
| 系统要求继续 | 系统恢复或控制逻辑主动触发 `continue` | compact 重试、max output recovery、stop hook blocking、token budget continuation |
| 正常续轮 | 工具已经执行完，需要带着 `tool_result` 和 attachment 回到模型 | `next_turn` |

这张表很重要，因为它说明“下一轮”并不只由模型决定，系统本身也会主动制造下一轮。

## 7. 终止条件与阅读心智模型

最终，`queryLoop()` 会在不同路径下返回不同 terminal reason。常见终止原因包括：

- `blocking_limit`
- `image_error`
- `model_error`
- `aborted_streaming`
- `prompt_too_long`
- `stop_hook_prevented`
- `hook_stopped`
- `aborted_tools`
- `max_turns`
- `completed`

这些返回值共同回答的是：“这次 agent loop 为什么停止在这里？”

### 7.1 一个简化心智模型

可以把 `src/query.ts` 想成下面这个状态机：

```text
while (true):
  1. 从 state 取出当前 messages / context / counters
  2. 在请求前先做上下文预处理与 compact
  3. 流式调用模型，累计 assistantMessages / toolUseBlocks
  4. 如果没有 tool_use：
       4.1 先跑错误恢复
       4.2 再跑 stop hooks / token budget
       4.3 决定 return 或 continue
  5. 如果有 tool_use：
       5.1 执行工具
       5.2 回写 tool_result / attachment / newContext
       5.3 检查 abort / hook stop / maxTurns
       5.4 写回 state 并继续下一轮
```

如果再压缩成一句话，这个 agent loop 的本质就是：

```text
request -> stream -> decide -> recover/execute -> enrich -> continue or return
```

这也是阅读 `query.ts` 时最稳的心智模型。

## 8. 与其他文档的边界

这篇文档只讲“编排”，不重复展开其他子系统的内部细节。

- 上下文压缩、microcompact、autocompact 的更细实现，继续看《上下文预处理》
- 工具注册、工具池组装、tool execution 管线，继续看《工具调用》
- 更宏观的系统分层和 QueryEngine/REPL 位置，继续看《架构分析》

可以把三篇文档的关系理解为：

```text
《上下文预处理》：query 之前，上下文怎样被整理
《工具调用》：tool_use 之后，工具怎样被执行
《Agent主循环》：这些步骤在 query.ts 里怎样被串成一个完整状态循环
```

因此，这篇文档关注的不是“单个模块怎么实现”，而是“这些模块在 `query.ts` 中如何协同工作”。
