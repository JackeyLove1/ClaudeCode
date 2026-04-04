export type ConnectorTextBlock = {
  type: 'connector_text'
  text?: string
  [key: string]: unknown
}

export function isConnectorTextBlock(
  value: unknown,
): value is ConnectorTextBlock {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    (value as { type?: unknown }).type === 'connector_text'
  )
}
