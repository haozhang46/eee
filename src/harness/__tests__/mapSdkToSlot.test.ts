import { describe, expect, test } from 'bun:test'
import { createSdkToSlotMapper } from '../mapSdkToSlot.js'

describe('createSdkToSlotMapper', () => {
  test('maps text_delta stream events', () => {
    const mapper = createSdkToSlotMapper()
    expect(
      mapper.map({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'hi' },
        },
      }),
    ).toEqual([{ type: 'text-delta', content: 'hi' }])
  })

  test('maps tool_use start then tool_result complete/error', () => {
    const mapper = createSdkToSlotMapper()
    expect(
      mapper.map({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 't1',
            name: 'WebSearch',
            input: { query: 'gz weather' },
          },
        },
      }),
    ).toEqual([
      {
        type: 'tool-call',
        toolCall: {
          id: 't1',
          toolName: 'WebSearch',
          input: { query: 'gz weather' },
          status: 'running',
        },
      },
    ])

    const done = mapper.map({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'ok',
            is_error: false,
          },
        ],
      },
    })
    expect(done).toEqual([
      {
        type: 'tool-call',
        toolCall: {
          id: 't1',
          toolName: 'WebSearch',
          input: { query: 'gz weather' },
          output: 'ok',
          status: 'complete',
        },
      },
      { type: 'tool-result', toolCallId: 't1', output: 'ok' },
    ])
  })

  test('does not forward subagent events — CCB owns that layer', () => {
    const mapper = createSdkToSlotMapper()
    expect(
      mapper.map({
        type: 'stream_event',
        parent_tool_use_id: 'agent-1',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: 'child-1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        },
      }),
    ).toEqual([])
    expect(
      mapper.map({
        type: 'stream_event',
        parent_tool_use_id: 'agent-1',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'internal' },
        },
      }),
    ).toEqual([])
  })

  test('maps result success and error', () => {
    const mapper = createSdkToSlotMapper()
    expect(mapper.map({ type: 'result', is_error: false, uuid: 'm1' })).toEqual(
      [{ type: 'done', messageId: 'm1' }],
    )
    expect(
      mapper.map({
        type: 'result',
        is_error: true,
        errors: ['boom'],
      }),
    ).toEqual([{ type: 'error', message: 'boom' }])
  })

  test('does not double-emit text when stream already sent deltas', () => {
    const mapper = createSdkToSlotMapper()
    mapper.map({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'a' },
      },
    })
    expect(
      mapper.map({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'a' }] },
      }),
    ).toEqual([])
  })
})
