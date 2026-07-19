import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HARNESS_JSON_BRIDGE_MD,
  bindCcbMemoryToHarness,
  harnessMemoryDir,
  injectHarnessMemoriesIntoPrompt,
  syncHarnessJsonToCcbMarkdown,
} from '../harnessMemory.ts'

describe('harnessMemory', () => {
  test('bindCcbMemoryToHarness sets CLAUDE_COWORK_MEMORY_PATH_OVERRIDE', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-mem-'))
    const prev = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
    try {
      const memDir = bindCcbMemoryToHarness(root)
      expect(memDir).toBe(harnessMemoryDir(root))
      expect(process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE).toBe(memDir)
    } finally {
      if (prev === undefined)
        delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
      else process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = prev
    }
  })

  test('syncHarnessJsonToCcbMarkdown bridges json into md + MEMORY.md', () => {
    const memDir = mkdtempSync(join(tmpdir(), 'harness-mem-sync-'))
    writeFileSync(
      join(memDir, 'mem_1.json'),
      JSON.stringify({
        id: 'mem_1',
        type: 'preference',
        content: 'Prefer TypeScript',
        timestamp: '2026-07-19T10:00:00.000Z',
      }),
      'utf-8',
    )
    writeFileSync(
      join(memDir, 'mem_2.json'),
      JSON.stringify({
        id: 'mem_2',
        type: 'fact',
        content: 'Uses bun',
        timestamp: '2026-07-19T11:00:00.000Z',
      }),
      'utf-8',
    )

    const { count, bridgePath } = syncHarnessJsonToCcbMarkdown(memDir)
    expect(count).toBe(2)
    expect(bridgePath).toBe(join(memDir, HARNESS_JSON_BRIDGE_MD))

    const md = readFileSync(bridgePath, 'utf-8')
    expect(md).toContain('Prefer TypeScript')
    expect(md).toContain('Uses bun')
    // newer first
    expect(md.indexOf('Uses bun')).toBeLessThan(md.indexOf('Prefer TypeScript'))

    const index = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8')
    expect(index).toContain(`@${HARNESS_JSON_BRIDGE_MD}`)

    // idempotent include
    syncHarnessJsonToCcbMarkdown(memDir)
    const index2 = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8')
    expect(index2.match(new RegExp(HARNESS_JSON_BRIDGE_MD, 'g'))?.length).toBe(
      1,
    )
  })

  test('injectHarnessMemoriesIntoPrompt sets CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES', () => {
    const prev = process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
    try {
      injectHarnessMemoriesIntoPrompt(['- [fact] hello memory'])
      expect(process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES).toContain(
        'hello memory',
      )
      expect(process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES).toContain(
        'Harness memory store',
      )
      injectHarnessMemoriesIntoPrompt([])
      expect(process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES).toBeUndefined()
    } finally {
      if (prev === undefined) {
        delete process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
      } else {
        process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES = prev
      }
    }
  })

  test('sync ignores non-json and corrupt files', () => {
    const memDir = mkdtempSync(join(tmpdir(), 'harness-mem-skip-'))
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'note.md'), '# hi', 'utf-8')
    writeFileSync(join(memDir, 'bad.json'), '{', 'utf-8')
    writeFileSync(
      join(memDir, 'ok.json'),
      JSON.stringify({
        id: 'x',
        type: 'fact',
        content: 'ok',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
      'utf-8',
    )
    expect(syncHarnessJsonToCcbMarkdown(memDir).count).toBe(1)
  })
})
