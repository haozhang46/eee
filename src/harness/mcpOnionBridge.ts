export interface BridgeClient {
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
}

let registeredClient: BridgeClient | null = null

export function setControlMcpClient(client: BridgeClient | null): void {
  registeredClient = client
}

export function getControlMcpClient(): BridgeClient | null {
  const mode = process.env.HARNESS_CONTROL_MCP?.trim()
  if (!mode) {
    return null
  }
  if (mode === 'stdio') {
    return registeredClient
  }
  return null
}

export async function authorizeViaMcp(
  client: BridgeClient,
  req: { toolName: string; input: Record<string, unknown>; sessionId: string },
): Promise<{ behavior: 'allow' | 'deny'; message?: string }> {
  let raw: unknown
  try {
    raw = await client.callTool('onion.authorize', req)
  } catch {
    return { behavior: 'deny', message: 'control unreachable' }
  }
  const r = raw as {
    decision?: string
    requestId?: string
    reason?: string
    message?: string
  }
  if (
    !r ||
    (r.decision !== 'allow' &&
      r.decision !== 'deny' &&
      r.decision !== 'needs_confirm')
  ) {
    return { behavior: 'deny', message: 'invalid authorize result' }
  }
  if (r.decision === 'allow') return { behavior: 'allow' }
  if (r.decision === 'deny') {
    return { behavior: 'deny', message: r.reason }
  }
  try {
    const waited = (await client.callTool('onion.wait_resolve', {
      requestId: r.requestId,
      timeoutMs: 60_000,
    })) as { decision?: string; reason?: string }
    if (waited?.decision === 'allow') return { behavior: 'allow' }
    return { behavior: 'deny', message: waited?.reason ?? 'denied by user' }
  } catch {
    return { behavior: 'deny', message: 'wait_resolve failed' }
  }
}
