type ControlMessage = {
  type: string
  [key: string]: unknown
}

export type SDKControlRequest = ControlMessage
export type SDKControlResponse = ControlMessage
export type SDKControlCancelRequest = ControlMessage
export type SDKControlPermissionRequest = ControlMessage
export type StdinMessage = ControlMessage
export type StdoutMessage = ControlMessage
