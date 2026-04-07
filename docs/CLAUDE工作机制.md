# CLAUDE.md 工作机制

## 1. 文档目标

这份文档回答一个具体问题：

这个仓库里的 `CLAUDE.md` 到底是怎样工作的？

先说结论：

它不是“启动时读一个根目录文本文件”这么简单，而是一套 instruction / memory 加载系统。系统会：

- 按不同作用域发现多类 instruction 文件
- 对文件内容做统一预处理
- 在会话开始时把一部分内容 eager load 到上下文里
- 在 Claude 触达具体文件时，再按路径懒加载补充规则
- 在 compact 之后清缓存并重新建立这些 instruction

如果只记 3 个主入口，最重要的是：

- `src/utils/claudemd.ts`：发现、解析、过滤、匹配
- `src/context.ts`：会话级注入
- `src/utils/attachments.ts`：文件级懒加载

## 2. 为什么它不是“单个文件”

`src/utils/claudemd.ts` 顶部已经把设计意图写得很清楚：Claude Code 读取的不是单一 `CLAUDE.md`，而是按层级组合出的 instruction 集合。

在当前实现里，核心层级有 4 层：

- `Managed`：受控全局指令，例如 `/etc/claude-code/CLAUDE.md`
- `User`：用户级全局指令，例如 `~/.claude/CLAUDE.md`
- `Project`：项目级共享指令，例如仓库里的 `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`
- `Local`：项目本地私有指令，例如 `CLAUDE.local.md`

这说明 `CLAUDE.md` 机制更像“多层 memory/source merge”，而不是“把一个 Markdown 文件原样塞进 prompt”。

另外，这个文件族也不是只有 eager load 这一种读法。项目启动时会先读一批“默认应该进上下文”的 instruction；当 Claude 进一步读取、编辑某个具体文件时，还会沿着文件路径去补充更细粒度的目录规则和 `paths` 规则。

## 3. 加载层级与优先级

### 3.1 总体层级

当前代码定义的总体顺序是：

```text
Managed -> User -> Project -> Local
```

但这只是“大类顺序”。

真正影响优先级的还有两个实现细节：

- 不同类型的文件按顺序追加到结果数组中
- 越靠近当前工作目录的项目级 / 本地级文件，会越晚被加载

因此对模型来说，后加载的文件优先级更高。

### 3.2 目录遍历顺序

对项目目录的遍历发生在 `getMemoryFiles()` 中。

它会：

1. 从 `originalCwd` 向上一路走到文件系统根目录
2. 先把这些目录收集起来
3. 再按“从根到当前目录”的顺序处理

这样做的效果是：

- 上层目录的 `CLAUDE.md` 会先进入结果
- 越靠近当前目录的 `CLAUDE.md` / `CLAUDE.local.md` / `.claude/rules/*.md` 会越晚进入结果
- 因而更贴近当前工作区的指令拥有更高优先级

这也是为什么一个 monorepo 可以同时拥有“仓库根规则”和“子模块规则”。

### 3.3 Nested worktree 的特殊处理

实现里还专门处理了 nested worktree。

如果当前目录是嵌套在主仓库里的 git worktree，系统会跳过主仓库工作树里那些会被重复加载的 `Project` 指令文件，避免同一套 checked-in 规则被读两遍；但 `CLAUDE.local.md` 这类本地文件仍然可以继续向上继承。

这说明加载顺序不只是目录遍历，还要兼顾 worktree 场景下的去重。

## 4. 文件发现范围

### 4.1 会话启动时默认发现哪些文件

`getMemoryFiles()` 会优先发现这几类文件：

- `CLAUDE.md`
- `.claude/CLAUDE.md`
- `.claude/rules/**/*.md`
- `CLAUDE.local.md`

其中：

- `Managed` 和 `User` 层来自固定路径
- `Project` 与 `Local` 层通过“从当前目录向上遍历”发现

### 4.2 `--add-dir` 扩展目录

如果开启 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`，系统还会读取 `--add-dir` 指定目录里的：

- `CLAUDE.md`
- `.claude/CLAUDE.md`
- `.claude/rules/**/*.md`

这意味着在 bare/受限模式下，Claude 仍然可以显式加载用户主动指定目录的 instruction。

### 4.3 项目初始化和 onboarding 只检查一部分

需要注意的是，onboarding 逻辑并不理解整套 memory 系统。

`src/projectOnboardingState.ts` 只是简单检查当前工作目录下是否存在根级 `CLAUDE.md`，并据此决定是否把“Run /init to create a CLAUDE.md file”标记为完成。

所以：

- onboarding 用的是“项目是否已有根级 `CLAUDE.md`”这个简化信号
- 真正运行时的 instruction 加载远比 onboarding 检查更复杂

## 5. 文件内容预处理

`CLAUDE.md` 文件被读到内存后，不会原样直接注入。

`src/utils/claudemd.ts` 在 `parseMemoryFileContent()` 里做了几层统一预处理。

### 5.1 frontmatter `paths`

文件 frontmatter 里的 `paths` 会通过 `parseFrontmatterPaths()` 解析出来。

它的作用不是给文件改内容，而是为这个 memory 文件附加一组 glob 模式，后续可以根据目标文件路径决定它是否生效。

这里还有两个实现特点：

- `/**` 后缀会被折叠成目录本体，方便后续匹配
- 如果 frontmatter 最终等价于全匹配，例如只有 `**`，实现会把它当成“没有条件限制”

### 5.2 HTML 注释剥离

`stripHtmlComments()` 会删除 Markdown 里的块级 HTML 注释，例如：

```md
<!-- 这段只是给维护者看的 -->
```

但它不会粗暴地把所有 `<!-- -->` 文本删光，而是通过 `marked` 的 lexer 只处理块级 comment，尽量避免误伤代码块和行内代码。

### 5.3 `@include`

memory 文件支持 `@path` 风格的 include 引用，例如：

- `@./relative/path.md`
- `@~/path.md`
- `@/absolute/path.md`
- `@some-file.md`

实现会在解析阶段把这些引用提取出来，解析成绝对路径，再递归读取。

这里要注意几个实现细节：

- include 只在普通文本节点里生效，不在 code block 和 code span 里生效
- include 有最大深度限制，当前是 `5`
- 系统会记录 `parent`，所以被 include 的文件不会简单内联成字符串，而是作为独立 memory entry 参与后续处理
- 非文本扩展名文件会被跳过，避免把图片、PDF 等二进制内容读进 instruction

### 5.4 文本扩展名限制

实现维护了一份允许被 `@include` 的文本扩展名白名单，覆盖：

- Markdown / 文本
- JSON / YAML / TOML / XML / CSV
- 各主流编程语言源码
- 常见配置文件与构建文件

如果 include 指向的文件扩展名不在允许范围内，就不会被读入 memory。

### 5.5 外部 include 限制

不是所有 memory 文件都能随意 include 工作区外的文件。

当前规则大致是：

- `User` memory 可以包含外部文件
- `Project` / `Local` memory 是否允许外部 include，取决于是否已获批准
- 系统也支持通过 `forceIncludeExternal` 路径先探测外部 include，再决定是否展示 warning

换句话说，`@include` 是能力，但不是无条件开放的能力。

### 5.6 `claudeMdExcludes`

`isClaudeMdExcluded()` 会检查用户配置里的 `claudeMdExcludes`。

它适用于：

- `User`
- `Project`
- `Local`

但不作用于：

- `Managed`
- `AutoMem`
- `TeamMem`

实现还会同时匹配原始路径和 realpath 解析后的路径，以处理 macOS 这类符号链接路径差异。

## 6. 两种注入方式

这是整个机制最容易被误解的地方。

当前实现不是“把所有 instruction 一次性塞进 system prompt”，而是至少有两条注入路径。

### 6.1 会话级 eager load

`src/context.ts` 的 `getUserContext()` 会在生成用户上下文时调用：

```ts
getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
```

这一步的作用是：

- 调用 `getMemoryFiles()` 收集当前会话默认应加载的 instruction
- 过滤掉某些不该直接注入的 memory entry
- 通过 `getClaudeMds()` 拼成统一的文本块
- 放进 `userContext.claudeMd`

`getClaudeMds()` 还会在最前面加上一段统一提示，大意是：

- 下面是代码库和用户提供的 instructions
- 这些 instructions 会覆盖默认行为
- 模型必须遵循这些 instructions

所以对主会话来说，`CLAUDE.md` 的第一种生效方式是：在 query 开始前，被整理成一段统一上下文文本进入 prompt。

### 6.2 文件级懒加载

第二种路径发生在 Claude 触达某个具体文件时。

`src/utils/attachments.ts` 会在相关工具读取/编辑文件时，调用 `getNestedMemoryAttachmentsForFile()`，再按目标文件路径补充 nested memory attachment。

这条路径不是重新构造整段 `claudeMd` 文本，而是额外注入 attachment。

它主要解决两个问题：

- 某些目录级规则只有在真正进入那个目录或触达那个文件时才应该生效
- 带 `paths` frontmatter 的 scoped rule，只有命中目标文件时才值得加载

### 6.3 这两条路径的分工

可以把它理解成：

- eager load 解决“会话开始时的默认指令底座”
- nested attachment 解决“操作具体文件时的局部补充”

两条路径配合后，Claude 才既能拿到全局上下文，又不会把所有细粒度规则都提前塞进主 prompt。

## 7. 条件规则与按路径匹配

`.claude/rules/*.md` 不只是普通的拆分文档，还支持条件匹配。

### 7.1 哪些文件会被当成 conditional rule

`processMdRules()` 读取 `.claude/rules/` 时，会区分两类规则：

- 没有 `paths` frontmatter 的 unconditional rule
- 带 `paths` frontmatter 的 conditional rule

后者只有在目标文件路径命中时，才会真正加入上下文。

### 7.2 匹配是如何计算的

真正的过滤逻辑在 `processConditionedMdRules()`。

它会：

1. 先读取 `.claude/rules/` 下所有带 `paths` 的 Markdown 文件
2. 为每个文件拿到 `globs`
3. 把目标文件路径转换成相对路径
4. 用 `ignore()` 判断该相对路径是否命中规则

基准目录也不是统一的：

- 对 `Project` 规则，匹配基准是 `.claude` 的父目录，也就是项目目录本身
- 对 `Managed` / `User` 规则，匹配基准是 `originalCwd`

所以同样一条 `paths` 规则，在 project 和 user 作用域下的解释上下文并不完全相同。

### 7.3 Nested attachment 的加载顺序

对某个目标文件，`getNestedMemoryAttachmentsForFile()` 的处理顺序是：

1. 先加载 `Managed` / `User` 里命中的 conditional rules
2. 再处理从 `CWD -> target` 之间每一层目录的 `CLAUDE.md`、unconditional rules、conditional rules
3. 最后处理 `root -> CWD` 这些目录层级里命中的 conditional rules

这个顺序让 scoped rule 既能继承全局条件，又能叠加目录局部条件。

## 8. 生命周期事件

`CLAUDE.md` 机制不仅是文件读取，还带有 hook 观测点。

### 8.1 `InstructionsLoaded` hook

当前实现支持 `InstructionsLoaded` hook。

它是一个 observability-only 的 hook，不负责拦截，只负责在 instruction 被加载时发出事件。

hook 元数据定义在 `src/utils/hooks/hooksConfigManager.ts`，而实际触发在两处：

- eager load：`src/utils/claudemd.ts`
- nested attachment：`src/utils/attachments.ts`

### 8.2 `load_reason`

当前实现里，instruction 文件被加载时会带上这些 `load_reason`：

- `session_start`
- `nested_traversal`
- `path_glob_match`
- `include`
- `compact`

可以这样理解：

- `session_start`：会话启动后的默认加载
- `nested_traversal`：因为 Claude 进入某个更深目录或文件上下文，触发了目录级补充
- `path_glob_match`：某条 `paths` 规则命中了目标文件
- `include`：该文件不是直接发现的，而是通过 `@include` 被读到
- `compact`：compact 清缓存后重新加载

这套 reason 让外部 hook 可以观察 instruction 生命周期，而不需要介入具体实现。

## 9. 与 `/init`、onboarding、compact 的关系

### 9.1 `/init`

`/init` 的作用不是参与运行时加载，而是帮助用户生成这些 instruction 文件。

从 `src/commands/init.ts` 的 prompt 可以看出，`/init` 明确把这些产物当作同一套系统的一部分来组织：

- `CLAUDE.md`
- `CLAUDE.local.md`
- `.claude/rules/*.md`
- 可选的 skills / hooks

也就是说，`/init` 是 instruction 系统的“生成入口”，不是“执行入口”。

### 9.2 project onboarding

项目 onboarding 比 `/init` 更简单。

它只检查当前工作目录下有没有根级 `CLAUDE.md`，据此决定项目是否完成初始化提示。这是一个产品层面的引导信号，不等价于完整 instruction 系统是否齐备。

### 9.3 compact 后会重新加载

compact 之后，系统不会假设旧的 instruction 仍然安全可用。

`src/services/compact/postCompactCleanup.ts` 会：

- 清掉 `getUserContext()` 的 memoized cache
- 调用 `resetGetMemoryFilesCache('compact')`

这样下一轮请求重新构建上下文时，就会再次走 `getMemoryFiles()` 和 `getClaudeMds()`，并且 `InstructionsLoaded` hook 会把这次重建标记为 `compact`。

这也解释了为什么在《上下文预处理》里会说 compact 后需要“重新建立” `CLAUDE.md` 和相关指令。

## 10. 一个端到端例子

可以用一个具体场景把整条链路串起来。

假设当前仓库有这些文件：

```text
/repo/CLAUDE.md
/repo/.claude/rules/testing.md
/repo/packages/web/CLAUDE.md
/repo/packages/web/.claude/rules/react.md
```

其中 `react.md` 带有 frontmatter：

```yaml
---
paths: src/**/*.{ts,tsx}
---
```

当一次会话开始时，大致会发生这些事情：

1. `getUserContext()` 调用 `getMemoryFiles()`
2. 系统先收集用户级 / 项目级 / 本地级默认 instruction
3. 根目录 `/repo/CLAUDE.md` 会被 eager load
4. `/repo/packages/web/CLAUDE.md` 是否 eager load，取决于当前 `originalCwd` 是否已经位于这个子目录或其下方
5. 这些文件通过 `getClaudeMds()` 被拼成统一的 `claudeMd` 文本进入上下文

接着，如果 Claude 读取了：

```text
/repo/packages/web/src/App.tsx
```

那么文件级懒加载会继续发生：

1. `attachments.ts` 以 `App.tsx` 为目标文件路径
2. 系统沿目录关系补充 `/repo/packages/web/CLAUDE.md`
3. 检查 `/repo/packages/web/.claude/rules/react.md` 的 `paths`
4. 因为 `src/App.tsx` 命中 `src/**/*.{ts,tsx}`，所以这条 scoped rule 会以 nested attachment 形式注入
5. 如果 `react.md` 里还有 `@./shared-style.md`，对应文件也会继续被读入，并带上 `parent` / `include` 信息

之后如果上下文触发 compact：

1. compact 会清理用户上下文缓存与 memory 文件缓存
2. 下一轮 query 重新执行 `getUserContext()`
3. 会话级 `claudeMd` 再次构建
4. `InstructionsLoaded` hook 会把这轮重建标记为 `compact`
5. 后续如果 Claude 再次触达 `App.tsx`，对应的 nested rule 仍然可以继续懒加载

这就是 `CLAUDE.md` 在当前仓库中的完整工作方式：

- 先建立会话级 instruction 底座
- 再按文件路径叠加局部规则
- compact 后刷新底座并继续支持局部补充

## 11. 结论

把 `CLAUDE.md` 当成“一个提示词文件”会低估当前实现。

更准确的说法是：

- 它是一套多来源、多层级的 instruction 发现与注入机制
- 它既支持启动时 eager load，也支持按目标文件懒加载
- 它支持 scoped rule、`@include`、excludes、external include 控制和 hook 观测
- 它和 `/init`、onboarding、compact 共同构成了 Claude Code 的 instruction 生命周期

如果要继续读源码，最推荐的顺序仍然是：

1. `src/utils/claudemd.ts`
2. `src/context.ts`
3. `src/utils/attachments.ts`

读完这三处，再回头看《Prompt系统》和《上下文预处理》，整个链路会更容易串起来。
