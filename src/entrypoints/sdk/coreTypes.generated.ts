export type SDKMessage = {
  type: string
  [key: string]: unknown
}

export type SDKUserMessage = SDKMessage
export type SDKResultMessage = SDKMessage
export type SDKResultSuccess = SDKMessage & {
  subtype?: 'success'
}
export type SDKSessionInfo = {
  sessionId?: string
  [key: string]: unknown
}

export type SDKAssistantMessageError = {
  message?: string
  [key: string]: unknown
}

export type HookEvent = (typeof import('./coreTypes.js').HOOK_EVENTS)[number]
