import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createHttpControlClient } from '../httpOnionClient.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('createHttpControlClient', () => {
  test('http bridge posts authorize', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({ decision: 'allow' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const client = createHttpControlClient('http://127.0.0.1:3100')
    const result = await client.callTool('onion.authorize', {
      toolName: 'Bash',
      input: { command: 'ls' },
      sessionId: 'sess-1',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:3100/api/agent/onion/authorize',
    )
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toEqual({
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      toolName: 'Bash',
      input: { command: 'ls' },
      sessionId: 'sess-1',
    })
    expect(result).toEqual({ decision: 'allow' })
  })

  test('http bridge posts wait_resolve', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify({ decision: 'allow' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const client = createHttpControlClient('http://127.0.0.1:3100/')
    const result = await client.callTool('onion.wait_resolve', {
      requestId: 'req-1',
      timeoutMs: 60_000,
    })

    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:3100/api/agent/onion/wait_resolve',
    )
    expect(result).toEqual({ decision: 'allow' })
  })

  test('unknown tool throws', async () => {
    const client = createHttpControlClient('http://127.0.0.1:3100')
    await expect(client.callTool('onion.unknown', {})).rejects.toThrow(
      /unknown tool/,
    )
  })

  test('non-ok response throws', async () => {
    globalThis.fetch = mock(async () => {
      return new Response('boom', { status: 503 })
    }) as typeof fetch

    const client = createHttpControlClient('http://127.0.0.1:3100')
    await expect(
      client.callTool('onion.authorize', { toolName: 'Bash' }),
    ).rejects.toThrow(/control 503/)
  })
})
