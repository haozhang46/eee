import { describe, expect, test } from 'bun:test'
import { formatToolResult } from '../formatToolResult'

describe('formatToolResult', () => {
  test('uses mapToolResultToToolResultBlockParam when available', () => {
    const tool = {
      mapToolResultToToolResultBlockParam(data: { stdout: string }, id: string) {
        return {
          tool_use_id: id,
          type: 'tool_result' as const,
          content: `OUT:${data.stdout}`,
        }
      },
    }
    const raw = { data: { stdout: 'hello', stderr: '', interrupted: false } }
    expect(formatToolResult(tool, raw, 't1')).toBe('OUT:hello')
  })

  test('formats bash-like data when mapper missing', () => {
    const raw = {
      data: {
        stdout: 'pong',
        stderr: 'warn',
        interrupted: false,
      },
    }
    const text = formatToolResult({}, raw, 't1')
    expect(text).toContain('pong')
    expect(text).toContain('warn')
  })

  test('surfaces interrupted with empty stdout instead of raw JSON dump', () => {
    const tool = {
      mapToolResultToToolResultBlockParam(
        data: { stdout: string; stderr: string; interrupted: boolean },
        id: string,
      ) {
        const parts = [data.stdout, data.stderr]
        if (data.interrupted) {
          parts.push('<error>Command was aborted before completion</error>')
        }
        return {
          tool_use_id: id,
          type: 'tool_result' as const,
          content: parts.filter(Boolean).join('\n'),
        }
      },
    }
    const raw = { data: { stdout: '', stderr: '', interrupted: true } }
    const text = formatToolResult(tool, raw, 't1')
    expect(text).toContain('aborted')
    expect(text).not.toContain('"data"')
  })

  test('falls back for plain string results', () => {
    expect(formatToolResult({}, 'ok', 't1')).toBe('ok')
  })
})
