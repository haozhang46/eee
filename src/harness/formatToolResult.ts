/**
 * Turn a CCB Tool.call() return value into model/UI-facing text.
 * Tools return `{ data: T }`; the readable form lives in
 * `mapToolResultToToolResultBlockParam`, not JSON.stringify(raw).
 */

type MappedBlock = {
  content?: string | Array<{ type?: string; text?: string } | string>
}

type ToolLike = {
  mapToolResultToToolResultBlockParam?: (
    data: unknown,
    toolUseID: string,
  ) => MappedBlock
}

function contentToString(content: MappedBlock['content']): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content)
  return content
    .map(block => {
      if (typeof block === 'string') return block
      if (block && typeof block === 'object' && 'text' in block) {
        return String(block.text ?? '')
      }
      return JSON.stringify(block)
    })
    .filter(Boolean)
    .join('\n')
}

function formatBashLikeData(data: Record<string, unknown>): string | null {
  if (!('stdout' in data) && !('stderr' in data) && !('interrupted' in data)) {
    return null
  }
  const parts: string[] = []
  const stdout = typeof data.stdout === 'string' ? data.stdout : ''
  const stderr = typeof data.stderr === 'string' ? data.stderr : ''
  if (stdout) parts.push(stdout)
  if (stderr) parts.push(stderr)
  if (data.interrupted) {
    parts.push('<error>Command was aborted before completion</error>')
  }
  if (
    typeof data.returnCodeInterpretation === 'string' &&
    data.returnCodeInterpretation
  ) {
    parts.push(data.returnCodeInterpretation)
  }
  if (parts.length === 0) {
    return '(no output)'
  }
  return parts.join('\n')
}

export function formatToolResult(
  tool: ToolLike,
  raw: unknown,
  toolUseID: string,
): string {
  if (typeof raw === 'string') return raw

  const data =
    raw &&
    typeof raw === 'object' &&
    'data' in raw &&
    (raw as { data: unknown }).data !== undefined
      ? (raw as { data: unknown }).data
      : raw

  if (typeof tool.mapToolResultToToolResultBlockParam === 'function') {
    try {
      const block = tool.mapToolResultToToolResultBlockParam(data, toolUseID)
      const text = contentToString(block?.content).trim()
      if (text) return text
    } catch {
      // fall through
    }
  }

  if (data && typeof data === 'object') {
    const bashLike = formatBashLikeData(data as Record<string, unknown>)
    if (bashLike) return bashLike
  }

  if (data == null) return '(no output)'
  if (typeof data === 'string') return data
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}
