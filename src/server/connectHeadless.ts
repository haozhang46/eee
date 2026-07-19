/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins */

import { randomUUID } from 'crypto'
import type { DirectConnectConfig } from './directConnectManager.js'
import type { StdoutMessage } from '../entrypoints/sdk/controlTypes.js'
import { logForDebugging } from '../utils/debug.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'

/**
 * Cache WebSocket.OPEN at module load time so it still works when
 * globalThis.WebSocket is replaced by a mock that lacks static OPEN.
 */
const WS_OPEN = WebSocket.OPEN

/**
 * Errors thrown by runConnectHeadless when the connection fails.
 */
export class ConnectHeadlessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectHeadlessError'
  }
}

function isStdoutMessage(value: unknown): value is StdoutMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as Record<string, unknown>).type === 'string'
  )
}

/**
 * Send a structured error response over WebSocket so the server doesn't
 * hang waiting for a reply to an unknown request subtype.
 */
function sendErrorResponse(
  ws: WebSocket,
  requestId: string,
  error: string,
): void {
  if (ws.readyState !== WS_OPEN) return
  ws.send(
    jsonStringify({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error,
      },
    }),
  )
}

/**
 * Send a permission allow response for auto-approved tool requests in
 * headless mode.
 */
function sendPermissionResponse(
  ws: WebSocket,
  requestId: string,
  result: { behavior: 'allow'; updatedInput?: Record<string, unknown> },
): void {
  if (ws.readyState !== WS_OPEN) return
  ws.send(
    jsonStringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: 'allow',
          ...(result.updatedInput ? { updatedInput: result.updatedInput } : {}),
        },
      },
    }),
  )
}

/**
 * Connect to a remote session and run in headless mode.
 *
 * - Headless (`prompt` is a non-empty string): sends the prompt as a user message,
 *   streams `StdoutMessage` NDJSON lines to stdout, and exits after receiving
 *   the final `result` message.
 * - Interactive (`prompt` is empty with `interactive=true`): pipes process stdin
 *   and stdout to/from the WebSocket.
 *
 * Throws ConnectHeadlessError on connection failures.
 */
export async function runConnectHeadless(
  connectConfig: DirectConnectConfig,
  prompt: string,
  outputFormat: string | undefined,
  interactive: boolean,
): Promise<void> {
  if (!connectConfig.wsUrl) {
    throw new ConnectHeadlessError('Missing WebSocket URL in connection config')
  }

  if (interactive && prompt) {
    throw new ConnectHeadlessError(
      'Cannot provide a prompt argument in interactive mode',
    )
  }

  const headers: Record<string, string> = {}
  if (connectConfig.authToken) {
    headers['authorization'] = `Bearer ${connectConfig.authToken}`
  }

  const ws = new WebSocket(connectConfig.wsUrl, {
    headers,
  } as unknown as string[])

  const fmt = outputFormat ?? ''
  const isStreamJson = fmt === 'stream-json'
  const isJson = fmt === 'json'

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    function scheduleIdleTimeout(): void {
      clearIdleTimeout()
      // Safety net: if no protocol messages arrive for 30s after the last
      // activity, resolve the promise. This prevents hangs in headless mode
      // when the remote server disconnects without sending a close frame or
      // a final result/error message. Resets on every received message.
      idleTimer = setTimeout(() => {
        logForDebugging('[ConnectHeadless] Idle timeout — no messages received')
        finish()
      }, 30_000)
    }

    function clearIdleTimeout(): void {
      if (idleTimer !== null) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }

    function finish(): void {
      if (settled) return
      settled = true
      clearTimeout(connectionTimeout)
      clearIdleTimeout()
      ws.close()
      if (interactive && !prompt) {
        const stdinRaw = process.stdin as unknown as NodeJS.ReadStream
        stdinRaw.setRawMode?.(false)
        stdinRaw.removeAllListeners('data')
      }
      resolve()
    }

    const connectionTimeout = setTimeout(() => {
      if (settled) return
      settled = true
      clearIdleTimeout()
      reject(new ConnectHeadlessError('WebSocket connection timed out'))
      ws.close()
    }, 15_000)

    ws.addEventListener('open', () => {
      clearTimeout(connectionTimeout)
      logForDebugging(
        `[ConnectHeadless] WebSocket connected: ${connectConfig.wsUrl}`,
      )

      if (!interactive && prompt) {
        // Headless mode: send the user prompt
        const userMessage = jsonStringify({
          type: 'user',
          uuid: randomUUID(),
          message: {
            role: 'user',
            content: prompt,
          },
        })
        ws.send(userMessage)
      }

      // Start idle timeout after open — resets on each received message
      scheduleIdleTimeout()
    })

    ws.addEventListener('message', (event: MessageEvent) => {
      // Reset idle timeout on any message activity
      scheduleIdleTimeout()

      const raw = typeof event.data === 'string' ? event.data : ''
      const lines = raw.split('\n').filter(l => l.trim())

      for (const line of lines) {
        let parsed: unknown
        try {
          parsed = jsonParse(line)
        } catch {
          continue
        }

        if (!isStdoutMessage(parsed)) continue

        const msg = parsed

        // Handle control requests
        if (msg.type === 'control_request') {
          const request = msg.request as Record<string, unknown> | undefined
          if (request?.subtype === 'can_use_tool') {
            // Auto-allow all tool requests in headless mode
            sendPermissionResponse(ws, msg.request_id as string, {
              behavior: 'allow',
            })
          } else {
            logForDebugging(
              `[ConnectHeadless] Unsupported control request subtype: ${String(request?.subtype)}`,
            )
            sendErrorResponse(
              ws,
              msg.request_id as string,
              `Unsupported control request subtype: ${String(request?.subtype)}`,
            )
          }
          continue
        }

        // Skip internal protocol messages
        if (
          msg.type === 'control_response' ||
          msg.type === 'keep_alive' ||
          msg.type === 'control_cancel_request' ||
          msg.type === 'streamlined_text' ||
          msg.type === 'streamlined_tool_use_summary' ||
          (msg.type === 'system' &&
            (msg as Record<string, unknown>).subtype === 'post_turn_summary')
        ) {
          continue
        }

        // StdoutMessage's discriminated union doesn't include 'error' in
        // its type field, even though the protocol uses error messages.
        // Cast to access the type dynamically.
        const msgType = (msg as Record<string, unknown>).type as string

        // Output to stdout based on format
        if (isStreamJson) {
          process.stdout.write(line + '\n')
        } else if (isJson) {
          // For json mode, we only print the final result
          if (msgType === 'result' || msgType === 'error') {
            process.stdout.write(line + '\n')
          }
        } else {
          // Text mode: extract text content from assistant messages
          if (msg.type === 'assistant') {
            const content = extractTextContent(msg)
            if (content) process.stdout.write(content)
          } else if (msgType === 'result') {
            const content = extractTextContent(msg)
            if (content) process.stdout.write(content + '\n')
          }
        }

        // Check if this is the final result
        if (msgType === 'result' || msgType === 'error') {
          const exitCode =
            msgType === 'error' || (msg as Record<string, unknown>).is_error
              ? 1
              : 0
          process.exitCode = exitCode
          finish()
        }
      }
    })

    ws.addEventListener('close', () => {
      logForDebugging('[ConnectHeadless] WebSocket closed')
      finish()
    })

    ws.addEventListener('error', () => {
      if (settled) return
      settled = true
      clearTimeout(connectionTimeout)
      clearIdleTimeout()
      reject(new ConnectHeadlessError('WebSocket connection error'))
    })

    // Interactive mode: forward stdin to WebSocket
    if (interactive && !prompt) {
      const stdinRaw = process.stdin as unknown as NodeJS.ReadStream
      if (stdinRaw.isTTY) {
        stdinRaw.setRawMode?.(true)
      }
      stdinRaw.on('data', (chunk: Buffer) => {
        if (ws.readyState === WS_OPEN) {
          const text = chunk.toString()
          if (text.trim()) {
            ws.send(
              jsonStringify({
                type: 'user',
                uuid: randomUUID(),
                message: {
                  role: 'user',
                  content: text,
                },
              }),
            )
          }
        }
      })
    }
  })
}

/**
 * Extract text content from a StdoutMessage.
 */
function extractTextContent(msg: StdoutMessage): string {
  const message = (msg as Record<string, unknown>).message as
    | Record<string, unknown>
    | undefined
  if (!message) return ''

  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (block: Record<string, unknown>) =>
          block.type === 'text' && typeof block.text === 'string',
      )
      .map((block: Record<string, unknown>) => block.text as string)
      .join('')
  }
  return ''
}
