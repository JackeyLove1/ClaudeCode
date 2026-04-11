# FileReadTool

`FileReadTool` 通过 `buildTool` 注册为只读工具，按文件类型分支处理：**文本**、**图片**、**Jupyter Notebook (`.ipynb`)**、**PDF**，以及**重复读的轻量占位结果**。实现见 `FileReadTool.ts`；提示文案与常量在 `prompt.js`，默认读写上限在 `limits.js`，UI 文案在 `UI.tsx`。

## 输入与校验

- **参数（Zod，`lazySchema`）**：`file_path`（绝对路径，描述如此约定）、可选 `offset` / `limit`（行号语义，配合 `semanticNumber`）、可选 `pages`（仅 PDF，如 `"1-5"`）。
- **`backfillObservableInput`**：对 `file_path` 做 `expandPath`，避免观测路径与真实解析不一致，从而绕过钩子/权限 allowlist（如 `~`、相对路径）。
- **`validateInput`（尽量少 I/O）**：
  - 解析并限制 `pages` 页范围（上限见 `PDF_MAX_PAGES_PER_READ`）。
  - 根据权限上下文匹配 **deny** 规则。
  - **UNC 路径**（`\\` 或 `//`）：校验阶段直接通过，把实际读文件推迟到用户授权之后，降低 NTLM 相关风险。
  - **二进制扩展名**：默认拒绝；**例外** PDF、常见图片扩展名（及工具链里视为可读的类型），由专门分支处理。
  - **设备路径**：仅路径匹配、不读盘，拦截会阻塞或无限输出的路径（如部分 `/dev/*`、`/proc/.../fd/0-2`）；`/dev/null` 等安全设备不在拦截列表中。

## 安全与模型侧提示

- 文本结果在映射到 API `tool_result` 时，可按当前主循环模型决定是否追加 **`CYBER_RISK_MITIGATION_REMINDER`**（部分模型在豁免集合中跳过）。
- **`extractSearchText`** 固定返回空字符串：UI 只展示摘要，不把正文当作可索引搜索文本（与 `UI.tsx` 约定一致）。

## 路径与「找不到文件」

- **`ENOENT`**：若路径符合 macOS 截图文件名模式，会尝试 **普通空格 ↔ U+202F（窄不换行空格）** 的互换路径再读一次（因系统版本差异）。
- 仍不存在时：结合 **`FILE_NOT_FOUND_CWD_NOTE`**、`suggestPathUnderCwd`、`findSimilarFile` 拼出友好错误信息。

## 成本：重复读去重

- 若上下文 **`readFileState`** 中有同一路径的非部分读记录，且 **`offset` / `limit` 与本次一致**，则用 **`mtime` 未变** 作为「文件未改」依据，直接返回 **`file_unchanged`**，避免重复塞入全文浪费 cache/token。
- 仅当历史记录的 `offset` 有定义时才参与去重（**Edit/Write** 写入的状态 `offset` 为 `undefined`，避免错误指向旧读到的内容）。
- 可通过 GrowthBook 特性 **`tengu_read_dedup_killswitch`** 关闭该行为。

## 资源与 token 限制

- **`maxResultSizeChars: Infinity`**：结果规模由 token/字节上限等机制约束；避免「把 Read 结果落盘再给模型 Read」的循环设计。
- **文本 / notebook JSON**：在 `validateContentTokens` 中先 **`roughTokenCountEstimationForFileType`**，估计较大时再 **`countTokensWithAPI`**；超限抛出 **`MaxFileReadTokenExceededError`**（提示使用 `offset`/`limit` 或搜索）。
- **文本范围读**：`readFileInRange`，传入 abort signal；无 `limit` 时用 **`maxSizeBytes`** 钳制读入范围。
- **图片**：`readImageWithTokenBudget` **只读一次磁盘**，再缩放/降采样；超 token 预算则更强压缩，必要时动态加载 **`sharp`** 做 JPEG fallback。

## 按类型的处理要点（`callInner`）

- **Notebook**：`readNotebook` → `jsonStringify`，按字节上限报错，并在错误信息中建议用 Bash + **`jq`** 分段查看 cells。
- **图片**：返回 `type: 'image'`；若有尺寸元数据可附加 **`newMessages`**（meta 用户消息）供坐标等对齐全文。
- **PDF**：
  - 指定 **`pages`**：抽取页为图，结果类型可为 **`parts`**，并通过 **`newMessages`** 附带多张 image block。
  - 未指定页数：若页数超过 **`PDF_AT_MENTION_INLINE_THRESHOLD`** 等策略会要求分页读；大文件或环境不支持时可能走页面抽取；全文 inline 时配合 **`readPDF`** 与 **document** block（`application/pdf`）。
- **纯文本**：更新 **`readFileState`**，对自动记忆类文件用 **`WeakMap`**（`memoryFileMtimes`）把 **mtime** 侧传给 `mapToolResultToToolResultBlockParam`，用于 freshness 前缀而不污染输出 schema 类型。

## `mapToolResultToToolResultBlockParam`

- **`image`** → `tool_result` 中带 base64 图片块。
- **`notebook`** → `mapNotebookCellsToToolResult` 映射为多块内容。
- **`pdf`** / **`parts`** → 正文以简短字符串摘要；PDF/抽取页的实质内容通过 **`newMessages`**（或其它补充分发路径）送达模型。
- **`text`** → 带行号格式化（`addLineNumbers` / `formatFileLines`）、可选记忆新鲜度前缀与网络安全提醒；空文件或 offset 越界用 **`<system-reminder>`** 提示。
- **`file_unchanged`** → 固定 stub 文案（`FILE_UNCHANGED_STUB`）。

## 扩展与遥测

- **`registerFileReadListener`**：文件读成功后可订阅；遍历时对 **`fileReadListeners.slice()`** 快照，避免回调内取消订阅导致跳过其他监听者。
- **技能目录**：非 simple 模式下 `discoverSkillDirsForPaths`、`addSkillDirectories`（异步 fire-and-forget）、`activateConditionalSkillsForPaths`。
- 日志与分析：`logFileOperation`、`logEvent`（如读限覆盖、PDF 抽取、session 类文件读、去重命中等）；session 文件类型由 **`detectSessionFileType`**（配置目录下路径启发式）区分。

## 相关导出

- **`registerFileReadListener`**、**`readImageWithTokenBudget`**、**`MaxFileReadTokenExceededError`**、**`CYBER_RISK_MITIGATION_REMINDER`** 等可供其他模块复用或测试。
