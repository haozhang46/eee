/**
 * Map QueryEngine SDKMessages → SlotEvent shapes for harness Chat SSE.
 * Slot / stdio stay loop-free; this is pure projection.
 *
 * Subagent work stays inside CCB (QueryEngine / Agent tool). Events with
 * `parent_tool_use_id` are not forwarded — the outer Slot/Web only sees
 * top-level tools (including the Agent tool itself).
 */

export interface ToolCallEvent {
  id: string
  toolName: string
  input: Record<string, unknown>
  output?: string
  status: 'pending' | 'running' | 'complete' | 'error'
}

export type SlotEvent =
  | { type: 'text-delta'; content: string }
  | { type: 'tool-call'; toolCall: ToolCallEvent }
  | { type: 'tool-result'; toolCallId: string; output: string }
  | { type: 'done'; messageId: string }
  | { type: 'error'; message: string }

type SdkLike = {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  errors?: string[]
  uuid?: string
  parent_tool_use_id?: string | null
  event?: {
    type?: string
    content_block?: Record<string, unknown>
    delta?: Record<string, unknown>
  }
  message?: {
    content?: Array<Record<string, unknown>>
  }
}

type ToolMeta = {
  toolName: string
  input: Record<string, unknown>
}

function stringifyContent(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>
          if (typeof b.text === 'string') return b.text
          if (typeof b.content === 'string') return b.content
        }
        return JSON.stringify(block)
      })
      .filter(Boolean)
      .join('\n')
  }
  return String(content)
}

function isSubagent(msg: SdkLike): boolean {
  const p = msg.parent_tool_use_id
  return p != null && p !== ''
}

function toolCallEvent(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  status: ToolCallEvent['status'],
  output?: string,
): SlotEvent {
  return {
    type: 'tool-call',
    toolCall: {
      id,
      toolName,
      input,
      status,
      ...(output !== undefined ? { output } : {}),
    },
  }
}

/**
 * Stateful mapper: tracks tool ids so results can complete prior tool-call events.
 */
export function createSdkToSlotMapper(): {
  map(msg: unknown): SlotEvent[]
} {
  const toolMeta = new Map<string, ToolMeta>()
  let streamedText = false

  return {
    map(msg: unknown): SlotEvent[] {
      const m = msg as SdkLike
      if (!m?.type) return []

      // Subagent traffic stays in CCB — outer Slot does not handle it.
      if (isSubagent(m)) return []

      if (m.type === 'stream_event' && m.event) {
        const ev = m.event
        if (ev.type === 'content_block_delta' && ev.delta) {
          const d = ev.delta
          if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
            streamedText = true
            return [{ type: 'text-delta', content: d.text }]
          }
        }
        if (ev.type === 'content_block_start' && ev.content_block) {
          const block = ev.content_block
          if (
            block.type === 'tool_use' ||
            block.type === 'server_tool_use' ||
            block.type === 'mcp_tool_use'
          ) {
            const id = String(block.id ?? '')
            if (!id || toolMeta.has(id)) return []
            const toolName = String(block.name ?? 'unknown')
            const input = (block.input as Record<string, unknown>) ?? {}
            toolMeta.set(id, { toolName, input })
            return [toolCallEvent(id, toolName, input, 'running')]
          }
        }
        return []
      }

      if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
        const out: SlotEvent[] = []
        for (const block of m.message!.content!) {
          if (block.type === 'text' && typeof block.text === 'string') {
            if (!streamedText && block.text) {
              out.push({ type: 'text-delta', content: block.text })
            }
          }
          if (
            block.type === 'tool_use' ||
            block.type === 'server_tool_use' ||
            block.type === 'mcp_tool_use'
          ) {
            const id = String(block.id ?? '')
            if (!id) continue
            const toolName = String(block.name ?? 'unknown')
            const input = (block.input as Record<string, unknown>) ?? {}
            toolMeta.set(id, { toolName, input })
            out.push(toolCallEvent(id, toolName, input, 'running'))
          }
        }
        return out
      }

      if (m.type === 'user' && Array.isArray(m.message?.content)) {
        const out: SlotEvent[] = []
        for (const block of m.message!.content!) {
          if (
            block.type !== 'tool_result' &&
            block.type !== 'mcp_tool_result'
          ) {
            continue
          }
          const toolCallId = String(block.tool_use_id ?? '')
          if (!toolCallId) continue
          const meta = toolMeta.get(toolCallId)
          const output = stringifyContent(block.content).slice(0, 4000)
          const isError = block.is_error === true
          out.push(
            toolCallEvent(
              toolCallId,
              meta?.toolName ?? 'tool',
              meta?.input ?? {},
              isError ? 'error' : 'complete',
              output,
            ),
          )
          out.push({ type: 'tool-result', toolCallId, output })
        }
        return out
      }

      if (m.type === 'result') {
        if (m.is_error) {
          const message =
            (Array.isArray(m.errors) && m.errors[0]) ||
            (typeof m.result === 'string' && m.result) ||
            'Agent error'
          return [{ type: 'error', message: String(message) }]
        }
        return [
          {
            type: 'done',
            messageId:
              typeof m.uuid === 'string' ? m.uuid : crypto.randomUUID(),
          },
        ]
      }

      return []
    },
  }
}
