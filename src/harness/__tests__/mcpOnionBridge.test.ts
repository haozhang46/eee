import { describe, expect, test } from 'bun:test'
import { authorizeViaMcp, type BridgeClient } from '../mcpOnionBridge.js'

function mockClient(
  handlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<unknown> | unknown
  >,
): BridgeClient {
  return {
    callTool: async (name, args) => {
      const handler = handlers[name]
      if (!handler) {
        throw new Error(`unexpected tool: ${name}`)
      }
      return handler(args)
    },
  }
}

const baseReq = {
  toolName: 'Bash',
  input: { command: 'ls' },
  sessionId: 'sess-1',
}

describe('authorizeViaMcp', () => {
  test('transport error → deny', async () => {
    const client: BridgeClient = {
      callTool: async () => {
        throw new Error('connection refused')
      },
    }

    const result = await authorizeViaMcp(client, baseReq)

    expect(result).toEqual({
      behavior: 'deny',
      message: 'control unreachable',
    })
  })

  test('allow decision → allow', async () => {
    const client = mockClient({
      'onion.authorize': async () => ({ decision: 'allow' }),
    })

    const result = await authorizeViaMcp(client, baseReq)

    expect(result).toEqual({ behavior: 'allow' })
  })

  test('MCP content envelope allow → allow', async () => {
    const client = mockClient({
      'onion.authorize': async () => ({
        content: [{ type: 'text', text: '{"decision":"allow"}' }],
      }),
    })

    const result = await authorizeViaMcp(client, baseReq)

    expect(result).toEqual({ behavior: 'allow' })
  })

  test('needs_confirm then wait allow → allow', async () => {
    const client = mockClient({
      'onion.authorize': async () => ({
        decision: 'needs_confirm',
        requestId: 'req-42',
      }),
      'onion.wait_resolve': async args => {
        expect(args).toEqual({ requestId: 'req-42', timeoutMs: 60_000 })
        return { decision: 'allow' }
      },
    })

    const result = await authorizeViaMcp(client, baseReq)

    expect(result).toEqual({ behavior: 'allow' })
  })

  test('needs_confirm then wait deny → deny', async () => {
    const client = mockClient({
      'onion.authorize': async () => ({
        decision: 'needs_confirm',
        requestId: 'req-99',
      }),
      'onion.wait_resolve': async () => ({
        decision: 'deny',
        reason: 'user rejected',
      }),
    })

    const result = await authorizeViaMcp(client, baseReq)

    expect(result).toEqual({
      behavior: 'deny',
      message: 'user rejected',
    })
  })
})
