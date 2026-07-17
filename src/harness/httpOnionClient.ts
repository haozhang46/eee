import type { BridgeClient } from './mcpOnionBridge.js'

/**
 * HTTP BridgeClient for Control onion endpoints.
 * Returns bare JSON objects (parseMcpToolResult passes plain objects through).
 */
export function createHttpControlClient(baseUrl: string): BridgeClient {
  const root = baseUrl.replace(/\/+$/, '')
  return {
    async callTool(name, args) {
      const path =
        name === 'onion.authorize'
          ? '/api/agent/onion/authorize'
          : name === 'onion.wait_resolve'
            ? '/api/agent/onion/wait_resolve'
            : null
      if (!path) throw new Error(`unknown tool ${name}`)
      const res = await fetch(`${root}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      })
      if (!res.ok) throw new Error(`control ${res.status}`)
      return res.json()
    },
  }
}
