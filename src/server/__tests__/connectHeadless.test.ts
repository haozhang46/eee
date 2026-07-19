import { describe, test, expect, mock } from 'bun:test'
import { runConnectHeadless } from '../connectHeadless.ts'

describe('runConnectHeadless', () => {
  test('connects WebSocket and sends user message in headless mode', async () => {
    const wsSend = mock()
    const wsClose = mock()
    const wsAddEventListener = mock()

    // Mock WebSocket constructor
    const origWebSocket = globalThis.WebSocket
    globalThis.WebSocket = class MockWebSocket {
      readyState = WebSocket.OPEN
      send = wsSend
      close = wsClose
      addEventListener = wsAddEventListener
      constructor(public url: string | URL, public protocols?: string | string[]) {}
    } as unknown as typeof WebSocket

    const config = {
      serverUrl: 'http://localhost:3456',
      sessionId: 'test-session',
      wsUrl: 'ws://localhost:3456/ws',
      authToken: 'test-token',
    }

    // Start headless mode with a prompt - this should connect and send
    const promise = runConnectHeadless(config, 'Hello', 'json', false)

    // Simulate WebSocket open
    const openHandler = wsAddEventListener.mock.calls.find(c => c[0] === 'open')?.[1]
    if (openHandler) openHandler()

    // Wait for message to be sent
    await Bun.sleep(50)

    expect(wsAddEventListener).toHaveBeenCalledWith('open', expect.any(Function))
    expect(wsAddEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    expect(wsAddEventListener).toHaveBeenCalledWith('close', expect.any(Function))
    expect(wsAddEventListener).toHaveBeenCalledWith('error', expect.any(Function))

    // Should have sent a user message over WebSocket
    expect(wsSend).toHaveBeenCalledTimes(1)
    const sentMsg = JSON.parse(wsSend.mock.calls[0][0])
    expect(sentMsg.type).toBe('user')
    expect(sentMsg.message.role).toBe('user')
    expect(sentMsg.message.content).toBe('Hello')

    // Cleanup
    await promise
    globalThis.WebSocket = origWebSocket
  })

  test('handles assistant messages from WebSocket in headless json mode', async () => {
    const capturedStdout: string[] = []
    const origWrite = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      capturedStdout.push(chunk.toString())
      return true
    }) as typeof process.stdout.write

    const wsHandlers = new Map<string, Function>()
    globalThis.WebSocket = class MockWebSocket {
      readyState = WebSocket.OPEN
      send = mock()
      close = mock()
      addEventListener = (ev: string, fn: Function) => wsHandlers.set(ev, fn)
      constructor(public url: string | URL, public protocols?: string | string[]) {}
    } as unknown as typeof WebSocket

    const config = {
      serverUrl: 'http://localhost:3456',
      sessionId: 'test-session',
      wsUrl: 'ws://localhost:3456/ws',
    }

    const promise = runConnectHeadless(config, 'Hello', 'json', false)

    // Connect
    wsHandlers.get('open')?.()
    await Bun.sleep(20)

    // Send a result message back
    const msgHandler = wsHandlers.get('message')
    const resultMsg = JSON.stringify({
      type: 'result',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello back' }] },
      uuid: '1234',
      session_id: 'test-session',
    })
    msgHandler?.({ data: resultMsg + '\n' })
    await Bun.sleep(20)

    // Send a final result to stop
    const finalMsg = JSON.stringify({
      type: 'result',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Final' }] },
      is_error: false,
      uuid: '5678',
      session_id: 'test-session',
    })
    msgHandler?.({ data: finalMsg + '\n' })
    await Bun.sleep(50)

    expect(capturedStdout.length).toBeGreaterThan(0)

    process.stdout.write = origWrite
    globalThis.WebSocket = WebSocket
    await promise.catch(() => {}) // ignore shutdown errors
  })

  test('sends error response for unsupported control request types', async () => {
    const wsSend = mock()
    const wsHandlers = new Map<string, Function>()
    globalThis.WebSocket = class MockWebSocket {
      readyState = WebSocket.OPEN
      send = wsSend
      close = mock()
      addEventListener = (ev: string, fn: Function) => wsHandlers.set(ev, fn)
      constructor(public url: string | URL, public protocols?: string | string[]) {}
    } as unknown as typeof WebSocket

    const config = {
      serverUrl: 'http://localhost:3456',
      sessionId: 'test-session',
      wsUrl: 'ws://localhost:3456/ws',
    }

    const promise = runConnectHeadless(config, 'Hello', 'json', false)
    wsHandlers.get('open')?.()
    await Bun.sleep(20)

    // Send an unsupported control request
    const msgHandler = wsHandlers.get('message')
    msgHandler?.({
      data: JSON.stringify({
        type: 'control_request',
        request_id: 'req-1',
        request: { subtype: 'unknown_type' },
      }) + '\n',
    })
    await Bun.sleep(20)

    // Should send an error response
    const errorResponse = wsSend.mock.calls.find(c => {
      const parsed = JSON.parse(c[0])
      return parsed.type === 'control_response' && parsed.response.subtype === 'error'
    })
    expect(errorResponse).toBeDefined()

    globalThis.WebSocket = WebSocket
    await promise.catch(() => {})
  })

  test('handles permission requests in headless mode', async () => {
    const wsSend = mock()
    const wsHandlers = new Map<string, Function>()
    globalThis.WebSocket = class MockWebSocket {
      readyState = WebSocket.OPEN
      send = wsSend
      close = mock()
      addEventListener = (ev: string, fn: Function) => wsHandlers.set(ev, fn)
      constructor(public url: string | URL, public protocols?: string | string[]) {}
    } as unknown as typeof WebSocket

    const config = {
      serverUrl: 'http://localhost:3456',
      sessionId: 'test-session',
      wsUrl: 'ws://localhost:3456/ws',
    }

    const promise = runConnectHeadless(config, 'Hello', 'json', false)
    wsHandlers.get('open')?.()
    await Bun.sleep(20)

    // Send a permission request for can_use_tool
    const msgHandler = wsHandlers.get('message')
    msgHandler?.({
      data: JSON.stringify({
        type: 'control_request',
        request_id: 'perm-1',
        request: {
          subtype: 'can_use_tool',
          tool_use_id: 'tool-1',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          tool_display_name: 'Bash',
        },
      }) + '\n',
    })
    await Bun.sleep(20)

    // Should auto-allow (headless mode)
    const allowResponse = wsSend.mock.calls.find(c => {
      const parsed = JSON.parse(c[0])
      return (
        parsed.type === 'control_response' &&
        parsed.response.subtype === 'success' &&
        parsed.response.response?.behavior === 'allow'
      )
    })
    expect(allowResponse).toBeDefined()

    globalThis.WebSocket = WebSocket
    await promise.catch(() => {})
  })

  test('rejects invalid connection config', async () => {
    const config = {
      serverUrl: 'http://localhost:3456',
      sessionId: 'test-session',
      wsUrl: '', // empty wsUrl should fail
    }

    await expect(runConnectHeadless(config, '', 'json', false)).rejects.toThrow()
  })
})
