import { describe, expect, test } from 'bun:test'
import { linkAbortSignal } from '../ccb-runner.js'
import { turnFailureTerminalEvents } from '../stdioBridge.js'

describe('turnFailureTerminalEvents', () => {
  test('aborted turn emits terminal error with turn id', () => {
    const events = turnFailureTerminalEvents(
      'turn-1',
      true,
      new Error('AbortError'),
    )
    expect(events).toEqual([
      { type: 'error', message: 'Turn aborted', id: 'turn-1' },
    ])
  })

  test('non-abort failure emits error then done', () => {
    const events = turnFailureTerminalEvents('turn-2', false, new Error('boom'))
    expect(events[0]).toEqual({ type: 'error', message: 'boom', id: 'turn-2' })
    expect(events[1]).toMatchObject({ type: 'done', id: 'turn-2' })
    expect(typeof (events[1] as { messageId?: string }).messageId).toBe(
      'string',
    )
  })
})

describe('linkAbortSignal', () => {
  test('forwards abort from inbound signal to tool controller', () => {
    const parent = new AbortController()
    const child = new AbortController()
    linkAbortSignal(parent.signal, child)
    expect(child.signal.aborted).toBe(false)
    parent.abort()
    expect(child.signal.aborted).toBe(true)
  })

  test('aborts child immediately when parent already aborted', () => {
    const parent = new AbortController()
    parent.abort()
    const child = new AbortController()
    linkAbortSignal(parent.signal, child)
    expect(child.signal.aborted).toBe(true)
  })
})
