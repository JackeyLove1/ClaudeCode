# Sandbox 机制分析

本文只分析当前仓库源码里能直接确认的 sandbox 机制，不追踪外部依赖 `@anthropic-ai/sandbox-runtime` 的内部实现。结论先说：

- 仓库内确实存在完整的 sandbox 接入链。
- sandbox 不是单个布尔开关，而是“配置 + 权限判定 + Shell 包装 + 网络授权回调 + UI/SDK/swarm 协同”的组合机制。
- 真正执行 OS 级隔离的底层能力来自外部依赖 `@anthropic-ai/sandbox-runtime`；本仓库负责的是配置生成、启停条件、调用时机、权限回调和结果治理。

## 1. 仓库里是否有 sandbox

有，而且是一级能力，不是实验性残留代码。

直接证据包括：

- `package.json`
  依赖声明了 `@anthropic-ai/sandbox-runtime`。
- `src/entrypoints/sandboxTypes.ts`
  定义了完整的 `sandbox` 配置 schema。
- `src/utils/sandbox/sandbox-adapter.ts`
  封装了仓库自己的 `SandboxManager`，作为 Claude Code 和外部 runtime 之间的适配层。
- `src/tools/BashTool/shouldUseSandbox.ts`
  决定某条 Bash 命令是否应该进入 sandbox。
- `src/utils/Shell.ts`
  真正执行命令前会调用 `SandboxManager.wrapWithSandbox(...)`。
- `src/commands/sandbox-toggle/*`
  暴露了 `/sandbox` 命令和 `/sandbox exclude ...` 用户入口。
- `src/screens/REPL.tsx`、`src/cli/structuredIO.ts`
  存在 sandbox 网络授权回调，说明运行时会把网络访问决策回传到 UI/SDK。

## 2. 总体架构

可以把仓库内的 sandbox 机制拆成 7 层：

1. 配置层
   `src/entrypoints/sandboxTypes.ts` 定义设置结构。
2. 启用判定层
   `src/utils/sandbox/sandbox-adapter.ts` 判断平台、依赖、策略是否允许启用。
3. Bash 入沙盒判定层
   `src/tools/BashTool/shouldUseSandbox.ts` 决定单条命令要不要走 sandbox。
4. 权限交互层
   `src/tools/BashTool/bashPermissions.ts` 决定 auto-allow / ask / deny / override 行为。
5. 运行时包装层
   `src/utils/Shell.ts` 在 `spawn` 前把命令包进 sandbox 运行字符串。
6. 网络授权层
   `src/screens/REPL.tsx`、`src/cli/structuredIO.ts`、`src/utils/swarm/permissionSync.ts` 处理网络访问授权。
7. UI/命令入口层
   `/sandbox`、`/sandbox exclude`、`/add-dir`、bridge `--sandbox` 暴露给用户或远程会话。

```mermaid
flowchart TD
    A[settings / flags / commands] --> B[SandboxManager.isSandboxingEnabled]
    B --> C[shouldUseSandbox(input)]
    C --> D[exec in src/utils/Shell.ts]
    D --> E[SandboxManager.wrapWithSandbox]
    E --> F[@anthropic-ai/sandbox-runtime]
    F --> G[violation / network ask callback]
    G --> H[REPL local dialog]
    G --> I[SDK structuredIO can_use_tool]
    G --> J[swarm mailbox request/response]
```

## 3. 配置层：`SandboxSettingsSchema`

源码位置：`src/entrypoints/sandboxTypes.ts`

这里是仓库内 sandbox 配置的单一来源。主要字段如下。

### 3.1 顶层开关

- `enabled`
  是否开启 sandbox。
- `failIfUnavailable`
  当用户显式启用 sandbox 但平台或依赖不满足时，是否直接拒绝启动。
- `autoAllowBashIfSandboxed`
  开启后，Bash 命令在“会进入 sandbox”的前提下可走自动放行逻辑。
- `allowUnsandboxedCommands`
  是否允许通过 `dangerouslyDisableSandbox` 退回到非 sandbox 执行。
- `excludedCommands`
  用户指定哪些命令模式不要进 sandbox。

### 3.2 网络配置：`sandbox.network`

- `allowedDomains`
  允许访问的域名列表。
- `allowManagedDomainsOnly`
  如果为真，只接受 managed/policy settings 里的允许域名和 WebFetch 域规则。
- `allowUnixSockets`
  允许的 Unix socket 路径。
- `allowAllUnixSockets`
  允许所有 Unix socket。
- `allowLocalBinding`
  是否允许本地绑定。
- `httpProxyPort`
  HTTP 代理端口。
- `socksProxyPort`
  SOCKS 代理端口。

### 3.3 文件系统配置：`sandbox.filesystem`

- `allowWrite`
  额外允许写入的路径。
- `denyWrite`
  额外拒绝写入的路径。
- `denyRead`
  额外拒绝读取的路径。
- `allowRead`
  在 `denyRead` 区域内重新放行的路径。
- `allowManagedReadPathsOnly`
  只接受 policy settings 提供的读路径白名单。

### 3.4 其他控制项

- `ignoreViolations`
  忽略特定 violation。
- `enableWeakerNestedSandbox`
  允许更弱的嵌套 sandbox。
- `enableWeakerNetworkIsolation`
  放宽部分网络隔离，注释里明确写了“降低安全性”。
- `ripgrep`
  为 sandbox 内的 ripgrep 提供 command/args。

## 4. 实现主链：`sandbox-adapter.ts`

源码位置：`src/utils/sandbox/sandbox-adapter.ts`

这个文件是核心适配层。它没有自己做 OS 级隔离，但它决定“外部 runtime 会拿到什么配置、何时初始化、何时刷新、如何做仓库特有的安全补丁”。

### 4.1 适配器职责

`SandboxManager` 对外暴露了一组仓库级接口：

- `initialize`
- `isSandboxingEnabled`
- `getSandboxUnavailableReason`
- `wrapWithSandbox`
- `refreshConfig`
- `cleanupAfterCommand`
- `checkDependencies`
- `setSandboxSettings`
- `getExcludedCommands`
- `getFsReadConfig`
- `getFsWriteConfig`
- `getNetworkRestrictionConfig`

其中很多方法是“仓库自实现 + 底层 runtime 转发”的混合体。

### 4.2 配置转换：`convertToSandboxRuntimeConfig()`

这个函数把 Claude Code 自己的 settings/permission 体系转换为 sandbox runtime 可消费的配置。

转换内容包括：

- 从 `permissions.allow` 和 `permissions.deny` 中提取 `WebFetch(domain:...)` 规则，合并成 `allowedDomains` / `deniedDomains`。
- 当 `allowManagedDomainsOnly` 开启时，只读 `policySettings` 里的域名允许列表。
- 初始化默认可写路径：
  `.` 和 Claude 临时目录 `getClaudeTempDir()`。
- 把所有 settings 文件路径加入 `denyWrite`。
- 把 managed settings drop-in 目录加入 `denyWrite`。
- 当当前 cwd 与原始 cwd 不同时，补充当前目录下 `.claude/settings.json` 和 `.claude/settings.local.json` 的写保护。
- 无条件保护 `.claude/skills`，避免通过技能目录写入绕过安全边界。
- 为 git bare-repo 逃逸场景做防御：
  存在的 `HEAD`、`objects`、`refs`、`hooks`、`config` 直接加入 `denyWrite`；
  不存在的路径记到 `bareGitRepoScrubPaths`，命令后做同步清理。
- 如果检测到 git worktree，允许写主仓库路径，避免 worktree 下 git 锁文件失败。
- 把 `permissions.additionalDirectories` 和运行期 `--add-dir` / `/add-dir` 注入的额外目录加入 `allowWrite`。
- 把 `Edit(...)` / `Read(...)` 权限规则转换为 `allowWrite` / `denyWrite` / `denyRead`。
- 把 `sandbox.filesystem.*` 的路径规则转成 runtime 的文件系统限制。
- 为 sandbox 生成 ripgrep 配置。

### 4.3 路径解析细节

这里刻意区分了两套路径语义：

- 权限规则路径
  通过 `resolvePathPatternForSandbox()` 解析，`//path` 表示绝对路径，`/path` 表示相对 settings 根目录。
- `sandbox.filesystem.*` 路径
  通过 `resolveSandboxFilesystemPath()` 解析，`/path` 直接按绝对路径处理，`./path` 或裸路径相对 settings 根目录。

也就是说，`Edit(/foo)` 和 `sandbox.filesystem.allowWrite: ["/foo"]` 在仓库里不是同一种语义。

### 4.4 启用条件

`isSandboxingEnabled()` 需要同时满足：

- 当前平台受支持。
- `checkDependencies()` 没有错误。
- 平台在 `enabledPlatforms` 白名单内。
- `sandbox.enabled === true`。

只要任何一项不满足，就不会真正启用 sandbox。

### 4.5 不可用原因

`getSandboxUnavailableReason()` 用来回答“用户明明开了 sandbox，为什么没生效”。

它会区分：

- WSL1 不支持。
- 当前平台不支持。
- `enabledPlatforms` 排除了当前平台。
- 依赖缺失。

`print.ts` 和 `REPL.tsx` 会在启动时调用它：

- 如果 `failIfUnavailable=true`，直接拒绝启动。
- 否则给出 warning，并明确说明“命令将不受 sandbox 保护”。

### 4.6 初始化与动态刷新

`initialize()` 做的事：

- 先检查 sandbox 是否启用。
- 只初始化一次，用 `initializationPromise` 防止竞态。
- 解析 git worktree 主仓路径。
- 生成 runtime config。
- 调用 `BaseSandboxManager.initialize(runtimeConfig, wrappedCallback)`。
- 订阅 settings 变化，发生变化时调用 `BaseSandboxManager.updateConfig(newConfig)`。

`refreshConfig()` 是同步刷新入口，供权限或工作目录变化后立即更新 runtime 配置，避免下一条命令命中旧配置。

`/add-dir` 的实现就会在更新目录后立刻调用它。

### 4.7 命令后清理

`cleanupAfterCommand()` 不是简单转发。它会：

- 先调用底层 `BaseSandboxManager.cleanupAfterCommand()`。
- 再执行仓库自己的 `scrubBareGitRepoFiles()`。

后者专门清理 sandbox 命令期间可能被种下的 bare git repo 痕迹，避免后续非 sandbox git 调用被利用。

## 5. Bash 何时进入 sandbox

源码位置：`src/tools/BashTool/shouldUseSandbox.ts`

判定逻辑非常直接：

1. `SandboxManager.isSandboxingEnabled()` 为假，直接不进 sandbox。
2. 如果调用参数里有 `dangerouslyDisableSandbox=true`，且策略允许非 sandbox 命令，则不进 sandbox。
3. 没有命令文本，不进 sandbox。
4. 命中 `sandbox.excludedCommands`，不进 sandbox。
5. 否则进入 sandbox。

`excludedCommands` 只是用户体验层便利功能，不是安全边界。源码注释明确写了：真正的安全控制仍然是 permission system。

### 5.1 `excludedCommands` 的匹配方式

`containsExcludedCommand()` 会做两件事：

- 拆分 compound command，逐个子命令匹配。
- 去掉前导环境变量和安全 wrapper，再匹配 exact/prefix/wildcard 规则。

这意味着下面这些都可能绕开 sandbox：

- 用户显式配置的命令模式。
- `/sandbox exclude "npm run test:*"` 加进去的模式。

但仓库作者把它定义为“选择不进 sandbox 的功能”，不是漏洞。

## 6. 权限交互：auto-allow / ask / deny / override

源码位置：`src/tools/BashTool/bashPermissions.ts`

sandbox 和 Bash 权限系统是耦合的，不是两条平行链路。

### 6.1 auto-allow 模式

当前提同时成立时：

- `SandboxManager.isSandboxingEnabled()`
- `SandboxManager.isAutoAllowBashIfSandboxedEnabled()`
- `shouldUseSandbox(input)`

会进入 `checkSandboxAutoAllow(...)`。

它的规则是：

- 如果 full command 命中显式 deny，返回 `deny`。
- 如果子命令命中显式 deny，返回 `deny`。
- 如果子命令命中 ask，返回 `ask`。
- 如果 full command 命中 ask，返回 `ask`。
- 上面都没有命中，则直接 `allow`，原因写成
  `Auto-allowed with sandbox (autoAllowBashIfSandboxed enabled)`。

也就是说，auto-allow 不是“所有命令都默默放行”，而是“没有显式 ask/deny 规则时，允许它在 sandbox 内执行”。

### 6.2 `dangerouslyDisableSandbox`

`BashTool` 的输入 schema 明确暴露了：

- `dangerouslyDisableSandbox?: boolean`

但是它是否生效，取决于 `allowUnsandboxedCommands`：

- 如果 `allowUnsandboxedCommands=true`，`shouldUseSandbox()` 会因为 override 返回 `false`。
- 如果 `allowUnsandboxedCommands=false`，这个参数在策略上被禁用，命令仍必须进入 sandbox。

`src/tools/BashTool/prompt.ts` 也把这层约束写进了给模型的工具提示：

- 默认所有命令都应该先在 sandbox 中执行。
- 只有用户明确要求绕过，或出现明显的 sandbox 失败证据时，才应使用 `dangerouslyDisableSandbox: true`。
- 如果策略禁止，则“所有命令必须运行在 sandbox 内”。

### 6.3 UI 上如何展示

`src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx` 会计算：

- sandbox 是否启用。
- 该命令是否会进入 sandbox。

如果启用了 sandbox 但当前命令没有进入，会在权限框标题上显示成 unsandboxed bash。

## 7. 运行时包装：`Shell.exec()`

源码位置：`src/utils/Shell.ts`

这里是“是否进入 sandbox”真正落地到进程执行的地方。

### 7.1 包装时机

`BashTool.call()` 最终会进入 `runShellCommand()`，然后调用：

- `exec(command, ..., { shouldUseSandbox: shouldUseSandbox(input) })`

`exec()` 里如果 `shouldUseSandbox` 为真，就会：

- 计算 sandbox 专用临时目录。
- 调用 `provider.buildExecCommand(...)` 生成命令字符串。
- 调用 `SandboxManager.wrapWithSandbox(commandString, sandboxBinShell, ...)`。
- 再用包装后的命令字符串执行 `spawn(...)`。

### 7.2 `$TMPDIR`

`Shell.ts` 会给 sandbox 命令准备专用临时目录，并把这个目录传进 shell provider。

`BashTool/prompt.ts` 也明确要求模型在 sandbox 模式下只使用 `$TMPDIR`，不要直接写 `/tmp`。

### 7.3 PowerShell 特殊处理

源码专门处理了 sandbox 下的 PowerShell：

- 不是直接把 `pwsh` 塞进 sandbox。
- 会先由 provider 构造 `pwsh -NoProfile -NonInteractive -EncodedCommand ...`。
- sandbox 的内层 shell 改成 `/bin/sh`。

这样做是为了避免 PowerShell profile 在 sandbox 中加载，导致延迟、杂音输出或卡住。

### 7.4 命令结束后的清理

`shellCommand.result.then(...)` 里有一个关键分支：

- 如果本次命令用了 sandbox，先执行 `SandboxManager.cleanupAfterCommand()`。

源码注释写得很清楚：Linux 下 bwrap 可能会在宿主机留下 0 字节挂载点文件，所以必须在命令结束后同步清理。

## 8. 网络授权链

sandbox 不只限制文件系统，也会限制网络访问。仓库内的设计是“底层 runtime 发现某个 host 不在允许范围内时，向上层要一次决策”。

### 8.1 REPL 本地交互

源码位置：`src/screens/REPL.tsx`

REPL 初始化 sandbox 时会传入 `sandboxAskCallback`。

普通本地场景下：

- 把请求加入 `sandboxPermissionRequestQueue`。
- 本地 UI 弹出授权对话框。
- 用户允许或拒绝后，resolve 对应 promise。

如果启用了 bridge，还会额外把请求发到 remote control 侧，走 `can_use_tool` 风格的控制请求。

### 8.2 SDK / print 模式

源码位置：`src/cli/structuredIO.ts`、`src/cli/print.ts`

`structuredIO.createSandboxAskCallback()` 会把网络授权请求转成一个 synthetic tool：

- tool name：`SANDBOX_NETWORK_ACCESS_TOOL_NAME`
- protocol subtype：`can_use_tool`
- description：`Allow network connection to <host>?`

也就是说，SDK host 不需要额外实现一套 sandbox 协议，而是复用既有权限请求协议。

### 8.3 swarm worker 转发

源码位置：

- `src/utils/swarm/permissionSync.ts`
- `src/hooks/useSwarmPermissionPoller.ts`
- `src/utils/teammateMailbox.ts`

当当前 agent 是 swarm worker 时：

1. worker 生成 `requestId`。
2. 通过 mailbox 发送 `sandbox_permission_request` 给 leader。
3. leader 审批后，再通过 mailbox 发回 `sandbox_permission_response`。
4. worker 本地 registry 根据 `requestId` 找到 callback，resolve 这次网络访问是否允许。

消息结构在 `teammateMailbox.ts` 中有明确 schema：

- `sandbox_permission_request`
  包含 `requestId`、`workerId`、`workerName`、`hostPattern.host`。
- `sandbox_permission_response`
  包含 `requestId`、`host`、`allow`。

### 8.4 managed-only 域名策略

`sandbox-adapter.ts` 在 `initialize()` 里会包一层 `wrappedCallback`：

- 如果 `shouldAllowManagedSandboxDomainsOnly()` 为真，直接拒绝所有运行期 ask，不再把问题转给用户。

也就是说，这个策略不是“UI 提示用户只可选 managed 域名”，而是直接在回调入口处短路拒绝。

## 9. 用户侧触发方式

这里把仓库内明确存在的触发入口单列出来。

### 9.1 settings

直接来自 `settings.json` / `settings.local.json` / policy / flags 的字段：

- `sandbox.enabled`
- `sandbox.failIfUnavailable`
- `sandbox.autoAllowBashIfSandboxed`
- `sandbox.allowUnsandboxedCommands`
- `sandbox.excludedCommands`
- `sandbox.network.*`
- `sandbox.filesystem.*`

这是最基础的触发入口。

### 9.2 `/sandbox`

源码位置：`src/commands/sandbox-toggle/*`

`/sandbox` 提供交互式设置界面，可以切换：

- `disabled`
- `regular`
- `auto-allow`

还可以配置 overrides：

- `Allow unsandboxed fallback`
- `Strict sandbox mode`

### 9.3 `/sandbox exclude "pattern"`

会调用 `addToExcludedCommands(...)`，把模式写入本地 settings 的 `sandbox.excludedCommands`。

后续 `shouldUseSandbox()` 再遇到匹配命令时，就不会进入 sandbox。

### 9.4 `/add-dir`

源码位置：`src/commands/add-dir/add-dir.tsx`

该命令会：

- 把目录加入工具工作目录权限。
- 更新 bootstrap state 中的额外目录。
- 立即调用 `SandboxManager.refreshConfig()`。

所以 `/add-dir` 不只是工具层放行，也会同步扩展 Bash sandbox 的可写目录。

### 9.5 `dangerouslyDisableSandbox`

这是单次 Bash 调用参数级触发方式，不是全局设置。

前提是：

- 该参数被传入。
- `allowUnsandboxedCommands=true`。

满足时，这一条命令不进 sandbox。

### 9.6 bridge `--sandbox` 与 `CLAUDE_CODE_FORCE_SANDBOX`

这条链属于远程会话层，不是本地 BashTool 自己的判定逻辑。

- `src/bridge/bridgeMain.ts` 解析 `--sandbox` / `--no-sandbox`。
- `src/bridge/sessionRunner.ts` 在启用时给子进程注入 `CLAUDE_CODE_FORCE_SANDBOX=1`。

这表示“远程 session 启动时，带上强制 sandbox 的环境参数”，而不是给 BashTool 新加一套独立权限系统。

## 10. 使用触发矩阵

| 场景 | 是否进 sandbox | 仓库内依据 |
| --- | --- | --- |
| 普通 Bash，sandbox 启用，未命中排除 | 是 | `shouldUseSandbox()` 返回 true |
| Bash 带 `dangerouslyDisableSandbox=true`，且允许 fallback | 否 | `allowUnsandboxedCommands=true` 时 override 生效 |
| Bash 带 `dangerouslyDisableSandbox=true`，但 strict mode | 是 | override 被策略禁用 |
| 命中 `excludedCommands` | 否 | `containsExcludedCommand()` |
| auto-allow 开启，且命令会进入 sandbox | 通常直接 allow 后在 sandbox 内执行 | `checkSandboxAutoAllow()` |
| auto-allow 开启，但命中 ask/deny 规则 | ask 或 deny | 同上 |
| 网络访问非白名单 host | 触发 ask callback | REPL / SDK / swarm |
| `allowManagedDomainsOnly=true` | 直接拒绝 ask callback | `wrappedCallback` 短路 |
| worker 模式下网络访问受限 host | 请求转发给 leader | mailbox `sandbox_permission_request/response` |
| bridge `--sandbox` | 远程子 session 带 sandbox 环境 | `CLAUDE_CODE_FORCE_SANDBOX` |

## 11. 远程 bridge 的 sandbox

这部分容易和本地 Bash sandbox 混淆，单独说明。

源码位置：

- `src/bridge/bridgeMain.ts`
- `src/bridge/types.ts`
- `src/bridge/sessionRunner.ts`
- `src/bridge/bridgeUI.ts`

仓库内可以确认的行为是：

- remote control 启动参数里有 `sandbox: boolean`。
- CLI 支持 `--sandbox`。
- bridge UI 会显示 `Sandbox: Enabled`。
- session runner 会把该值转成子进程环境变量 `CLAUDE_CODE_FORCE_SANDBOX=1`。

仓库内不能确认的是：

- 这个环境变量在子进程更深层到底如何影响底层 runtime。

因此这部分在本文中只归纳为“远程会话启动参数”，不把它误写成 BashTool 的另一套 sandbox 判定链。

## 12. 仓库边界：哪些能确认，哪些不能

当前仓库源码能确认：

- sandbox 的配置结构。
- sandbox 是否启用的判定条件。
- BashTool 何时进入 sandbox。
- 命令执行前如何包裹到 sandbox runtime。
- 网络访问受限时如何把授权请求回传到 REPL / SDK / swarm。
- sandbox 命令结束后有哪些仓库自定义清理逻辑。

当前仓库源码不能确认：

- `@anthropic-ai/sandbox-runtime` 内部怎样调用 bwrap、seccomp、代理、socket 拦截或 macOS 沙箱机制。
- 底层 runtime 如何具体实现 violation 检测和 host 级网络阻断。
- `CLAUDE_CODE_FORCE_SANDBOX` 在子进程更深处的最终解释逻辑。

所以如果问题是“仓库里有没有 sandbox，以及它是如何接入和触发的”，当前文档已经完整回答。

如果问题升级成“底层 OS 级隔离到底怎么实现”，就必须继续分析外部依赖包，而这已经超出本仓库源码范围。

## 13. 总结

仓库内的 sandbox 机制可以概括成一句话：

> Claude Code 在仓库内部并不自己实现 OS 级沙盒，而是围绕 `@anthropic-ai/sandbox-runtime` 建了一层完整的接入与治理框架，负责配置转换、启用判定、Bash 入沙盒决策、运行时包装、网络授权回调、swarm 转发，以及命令后的安全清理。

从调用链上看，最关键的主路径是：

`settings -> SandboxManager.isSandboxingEnabled -> shouldUseSandbox -> Shell.exec -> wrapWithSandbox -> sandbox runtime -> violation/ask callback -> UI/SDK/swarm response`

从使用方式上看，最关键的触发入口是：

- settings 中的 `sandbox.*`
- `/sandbox`
- `/sandbox exclude ...`
- `/add-dir`
- Bash 参数 `dangerouslyDisableSandbox`
- remote bridge 的 `--sandbox`

这说明 sandbox 在本仓库里不是孤立组件，而是权限系统、Shell 系统、会话系统、远程控制系统共同参与的一条主干能力链。
