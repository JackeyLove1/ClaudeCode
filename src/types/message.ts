type AnyRecord = Record<string, unknown>

type MessageBase = {
  uuid?: string
  timestamp?: number
  type: string
  [key: string]: unknown
}

export type PartialCompactDirection = 'before' | 'after'

export type RequestStartEvent = AnyRecord
export type StopHookInfo = AnyRecord
export type StreamEvent = AnyRecord

export type AssistantMessage = MessageBase & {
  type: 'assistant'
  uuid: string
  message: {
    content: unknown[]
    [key: string]: unknown
  }
  advisorModel?: string | null
}

export type AttachmentMessage = MessageBase & {
  type: 'attachment'
  attachment: AnyRecord
}

export type ProgressMessage = MessageBase & {
  type: 'progress'
}

export type UserMessage = MessageBase & {
  type: 'user'
  message?: {
    content?: unknown[]
    [key: string]: unknown
  }
}

export type SystemMessage = MessageBase & {
  type: 'system'
  level?: SystemMessageLevel
}

export type TombstoneMessage = MessageBase & {
  type: 'tombstone'
}

export type ToolUseSummaryMessage = MessageBase & {
  type: 'tool_use_summary'
}

export type SystemLocalCommandMessage = SystemMessage
export type SystemAgentsKilledMessage = SystemMessage
export type SystemAPIErrorMessage = SystemMessage
export type SystemApiMetricsMessage = SystemMessage
export type SystemAwaySummaryMessage = SystemMessage
export type SystemBridgeStatusMessage = SystemMessage
export type SystemCompactBoundaryMessage = SystemMessage
export type SystemInformationalMessage = SystemMessage
export type SystemMemorySavedMessage = SystemMessage
export type SystemMicrocompactBoundaryMessage = SystemMessage
export type SystemPermissionRetryMessage = SystemMessage
export type SystemScheduledTaskFireMessage = SystemMessage
export type SystemStopHookSummaryMessage = SystemMessage
export type SystemTurnDurationMessage = SystemMessage

export type NormalizedAssistantMessage = AssistantMessage
export type NormalizedUserMessage = UserMessage
export type NormalizedMessage =
  | AssistantMessage
  | AttachmentMessage
  | ProgressMessage
  | SystemMessage
  | UserMessage
  | TombstoneMessage
  | ToolUseSummaryMessage

export type GroupedToolUseMessage = MessageBase & {
  type: 'grouped_tool_use'
}

export type CollapsedReadSearchGroup = MessageBase & {
  type: 'collapsed_read_search_group'
}

export type RenderableMessage =
  | NormalizedMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup

export type HookResultMessage = MessageBase & {
  type: 'hook_result'
}

export type Message =
  | AssistantMessage
  | AttachmentMessage
  | ProgressMessage
  | SystemMessage
  | UserMessage
  | TombstoneMessage
  | ToolUseSummaryMessage
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup
  | HookResultMessage

export type MessageOrigin = 'user' | 'assistant' | 'system' | 'tool'
export type SystemMessageLevel = 'info' | 'warning' | 'error'
