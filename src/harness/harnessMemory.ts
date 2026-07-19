/**
 * Point CCB auto-memory at workspace `.harness/memory/` and bridge
 * existing harness JSON entries into markdown CCB can load.
 *
 * Why EXTRA_GUIDELINES: with `tengu_moth_copse` on (CCB default), MEMORY.md /
 * AutoMem is NOT injected into context — only relevance-prefetch attachments.
 * Harness wants durable JSON memories always visible, so we also push the
 * bridge body into CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES (folded into
 * loadMemoryPrompt every turn).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { extname, join } from 'node:path'

export const HARNESS_MEMORY_REL = join('.harness', 'memory')
/** Bridged markdown (CCB reads .md; harness UI only lists .json). */
export const HARNESS_JSON_BRIDGE_MD = 'harness-json-store.md'
const MEMORY_INDEX = 'MEMORY.md'
const DEFAULT_MAX = 200
/** Keep under MEMORY.md entrypoint byte-ish budget for prompt injection. */
export const EXTRA_GUIDELINES_MAX_CHARS = 20_000

export function harnessMemoryDir(workspaceRoot: string): string {
  return join(workspaceRoot, HARNESS_MEMORY_REL)
}

/**
 * Redirect getAutoMemPath() to `.harness/memory` for this process.
 * Must run before the first getAutoMemPath() call (or clear its cache).
 */
export function bindCcbMemoryToHarness(workspaceRoot: string): string {
  const memDir = harnessMemoryDir(workspaceRoot)
  mkdirSync(memDir, { recursive: true })
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = memDir
  return memDir
}

type JsonMem = {
  id?: string
  type?: string
  content?: string
  timestamp?: string
}

function collectJsonEntries(
  memDir: string,
  maxEntries: number,
): Array<JsonMem & { content: string; timestamp: string }> {
  const entries: Array<JsonMem & { content: string; timestamp: string }> = []
  for (const file of readdirSync(memDir)) {
    if (extname(file) !== '.json') continue
    try {
      const raw = JSON.parse(
        readFileSync(join(memDir, file), 'utf-8'),
      ) as JsonMem
      if (typeof raw.content !== 'string' || !raw.content.trim()) continue
      entries.push({
        ...raw,
        content: raw.content.trim(),
        timestamp:
          typeof raw.timestamp === 'string' && raw.timestamp
            ? raw.timestamp
            : '',
      })
    } catch {
      // skip corrupt
    }
  }
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  return entries.slice(0, maxEntries)
}

function formatBullets(
  entries: Array<{ type?: string; content: string }>,
): string[] {
  return entries.map(
    e => `- [${e.type ?? 'fact'}] ${e.content.replace(/\n/g, ' ')}`,
  )
}

/**
 * Sync `.harness/memory/*.json` → `harness-json-store.md` + MEMORY.md @include
 * so classic AutoMem load (moth_copse off) can pull the body.
 */
export function syncHarnessJsonToCcbMarkdown(
  memDir: string,
  maxEntries: number = DEFAULT_MAX,
): { count: number; bridgePath: string; bullets: string[] } {
  mkdirSync(memDir, { recursive: true })

  const capped = collectJsonEntries(memDir, maxEntries)
  const bullets = formatBullets(capped)
  const md = [
    '---',
    'name: harness-json-store',
    'description: Synced from harness .harness/memory/*.json (UI memory store)',
    'type: project',
    '---',
    '',
    'These entries come from the harness console memory store. Prefer them as durable user/project facts.',
    '',
    ...bullets,
    '',
  ].join('\n')

  const bridgePath = join(memDir, HARNESS_JSON_BRIDGE_MD)
  writeFileSync(bridgePath, md, 'utf-8')

  // @include is how claudemd pulls topic files; a markdown link alone is NOT loaded.
  const includeLine = `@${HARNESS_JSON_BRIDGE_MD}`
  const indexPath = join(memDir, MEMORY_INDEX)
  let index = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : ''
  if (!index.includes(HARNESS_JSON_BRIDGE_MD)) {
    index = `${includeLine}\n`
    writeFileSync(indexPath, index, 'utf-8')
  } else if (!index.includes(includeLine)) {
    // Upgrade legacy markdown-link pointer to @include
    index = `${includeLine}\n${index}`
    writeFileSync(indexPath, index, 'utf-8')
  }

  return { count: capped.length, bridgePath, bullets }
}

/**
 * Always-on injection into loadMemoryPrompt (works even when moth_copse
 * strips AutoMem from user context).
 */
export function injectHarnessMemoriesIntoPrompt(bullets: string[]): void {
  if (bullets.length === 0) {
    delete process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
    return
  }
  const header = [
    '## Harness memory store (always loaded)',
    'Treat these as durable facts/preferences from prior harness console chats:',
    '',
  ].join('\n')
  let body = bullets.join('\n')
  const budget = EXTRA_GUIDELINES_MAX_CHARS - header.length
  if (body.length > budget) {
    body = body.slice(0, body.lastIndexOf('\n', budget) || budget)
  }
  process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES = header + body
}

/** Bind path + sync JSON bridge + inject into system prompt. */
export async function applyHarnessMemoryForCcb(
  workspaceRoot: string,
): Promise<{ memDir: string; synced: number }> {
  const memDir = bindCcbMemoryToHarness(workspaceRoot)
  const { count, bullets } = syncHarnessJsonToCcbMarkdown(memDir)
  injectHarnessMemoriesIntoPrompt(bullets)
  const { getAutoMemPath } = await import('../memdir/paths.js')
  getAutoMemPath.cache?.clear?.()
  return { memDir, synced: count }
}
