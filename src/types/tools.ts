type AnyProgress = {
  type?: string
  message?: string
  [key: string]: unknown
}

export type AgentToolProgress = AnyProgress
export type BashProgress = AnyProgress
export type MCPProgress = AnyProgress
export type REPLToolProgress = AnyProgress
export type ShellProgress = AnyProgress
export type SkillToolProgress = AnyProgress
export type SdkWorkflowProgress = AnyProgress
export type TaskOutputProgress = AnyProgress
export type ToolProgressData = AnyProgress
export type WebSearchProgress = AnyProgress
