/**
 * Harness Chat agent entry — thin bootstrap around CCB QueryEngine (`ask`).
 * No DIY tool loop: schema, retries, commands, agents live in query.ts.
 *
 * SlotEvent shapes duplicated locally (do not import @harness/slot).
 */
import { feature } from 'bun:bundle'
import { join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import {
  createSdkToSlotMapper,
  type SlotEvent,
  type ToolCallEvent,
} from './mapSdkToSlot.js'
import { applyHarnessMemoryForCcb } from './harnessMemory.js'

export type { SlotEvent, ToolCallEvent }

/** CLI calls this via startBackgroundHousekeeping; harness ask() path must too. */
let extractMemoriesInited = false

async function ensureExtractMemoriesInit(
  workspaceRoot: string,
): Promise<void> {
  if (feature('EXTRACT_MEMORIES')) {
    if (extractMemoriesInited) return
    extractMemoriesInited = true
    const { initExtractMemories } = await import(
      '../services/extractMemories/extractMemories.js'
    )
    initExtractMemories()
    runnerLog(workspaceRoot, 'extractMemories', 'initExtractMemories()')
  }
}

async function drainExtractMemories(): Promise<void> {
  if (feature('EXTRACT_MEMORIES')) {
    const { drainPendingExtraction } = await import(
      '../services/extractMemories/extractMemories.js'
    )
    // Fire-and-forget from stopHooks; wait so writes land before the turn settles.
    await drainPendingExtraction(60_000)
  }
}

interface LLMSettings {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

/** Debug log to workspace `.harness/runner.log` (stdout is JSONL — do not console.log). */
function runnerLog(workspaceRoot: string, ...args: unknown[]): void {
  try {
    const dir = join(workspaceRoot, '.harness')
    mkdirSync(dir, { recursive: true })
    const line = `[${new Date().toISOString()}] ${args
      .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')}\n`
    appendFileSync(join(dir, 'runner.log'), line)
  } catch {
    // best-effort
  }
}

function loadLLM(cwd: string): LLMSettings {
  const path = join(cwd, '.harness', 'llm.json')
  if (!existsSync(path)) {
    return {
      model: 'deepseek-chat',
      provider: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
    }
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as LLMSettings
  } catch {
    return {
      model: 'deepseek-chat',
      provider: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
    }
  }
}

/** Wire inbound turn AbortSignal into tool ctx.abortController. */
export function linkAbortSignal(
  signal: AbortSignal,
  controller: AbortController,
): void {
  if (signal.aborted) {
    controller.abort()
    return
  }
  signal.addEventListener('abort', () => controller.abort(), { once: true })
}

async function applyLlmEnv(llm: LLMSettings): Promise<void> {
  // Clear OpenAI-compat flags first so Cloud↔Ollama switches don't leak.
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_KEY

  if (llm.provider === 'openai') {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_MODEL = llm.model
    process.env.OPENAI_BASE_URL = llm.baseUrl
    process.env.OPENAI_API_KEY = llm.apiKey
  }

  try {
    const { clearOpenAIClientCache } = await import(
      '../services/api/openai/client.js'
    )
    clearOpenAIClientCache()
  } catch {
    // best-effort
  }
}

export async function* runCCBAgent(
  messages: Array<{ role: string; content: string }>,
  workspaceRoot: string,
  signal: AbortSignal,
): AsyncGenerator<SlotEvent> {
  const llm = loadLLM(workspaceRoot)
  runnerLog(workspaceRoot, 'llm', {
    provider: llm.provider,
    model: llm.model,
    baseUrl: llm.baseUrl,
    hasApiKey: Boolean(llm.apiKey),
  })
  if (!llm.apiKey) {
    yield {
      type: 'text-delta',
      content: 'Please configure your LLM API key in Settings first.\n',
    }
    yield { type: 'done', messageId: crypto.randomUUID() }
    return
  }
  await applyLlmEnv(llm)

  const [
    { enableConfigs },
    { getTools },
    { getEmptyToolPermissionContext },
    { FileStateCache },
    { hasPermissionsToUseTool },
    { ask },
    { getCommands },
    { getAgentDefinitionsWithOverrides },
    { getDefaultAppState },
    { setOriginalCwd },
    { createUserMessage, createAssistantMessage },
    { resetSettingsCache },
    { applySafeConfigEnvironmentVariables },
  ] = await Promise.all([
    import('../utils/config.js'),
    import('../tools.js'),
    import('../Tool.js'),
    import('../utils/fileStateCache.js'),
    import('../utils/permissions/permissions.js'),
    import('../QueryEngine.js'),
    import('../commands.js'),
    import(
      '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
    ),
    import('../state/AppStateStore.js'),
    import('../bootstrap/state.js'),
    import('../utils/messages.js'),
    import('../utils/settings/settingsCache.js'),
    import('../utils/managedEnv.js'),
  ])

  enableConfigs()
  setOriginalCwd(workspaceRoot)
  try {
    process.chdir(workspaceRoot)
  } catch {
    // best-effort
  }
  resetSettingsCache()
  applySafeConfigEnvironmentVariables()
  const { memDir, synced } = await applyHarnessMemoryForCcb(workspaceRoot)
  runnerLog(workspaceRoot, 'memory', { memDir, synced })
  await ensureExtractMemoriesInit(workspaceRoot)

  const permissionContext = getEmptyToolPermissionContext()
  const tools = getTools(permissionContext)
  const [commands, agentDefinitions] = await Promise.all([
    getCommands(workspaceRoot),
    getAgentDefinitionsWithOverrides(workspaceRoot),
  ])

  let appState = {
    ...getDefaultAppState(),
    toolPermissionContext: {
      ...permissionContext,
      mode: 'default' as const,
    },
    agentDefinitions,
  }

  const abortController = new AbortController()
  linkAbortSignal(signal, abortController)

  let readFileCache = new FileStateCache(500, 50 * 1024 * 1024)

  const last = messages[messages.length - 1]
  const prompt =
    last?.role === 'user'
      ? last.content
      : (messages.filter(m => m.role === 'user').at(-1)?.content ?? '')
  if (!prompt) {
    yield { type: 'error', message: 'No user message in turn' }
    return
  }

  const prior = messages.slice(0, -1).flatMap(m => {
    if (m.role === 'user') {
      return [createUserMessage({ content: m.content })]
    }
    if (m.role === 'assistant') {
      return [createAssistantMessage({ content: m.content })]
    }
    return []
  })

  console.error(
    `[harness:runner] ask() with ${tools.length} tools, ${commands.length} commands, ${agentDefinitions.activeAgents.length} agents`,
  )

  const mapper = createSdkToSlotMapper()
  let sawDone = false
  let sawError = false

  try {
    for await (const sdkMsg of ask({
      commands,
      prompt,
      cwd: workspaceRoot,
      tools,
      mcpClients: [],
      agents: agentDefinitions.activeAgents,
      canUseTool: hasPermissionsToUseTool,
      mutableMessages: prior,
      getAppState: () => appState,
      setAppState: f => {
        appState = f(appState)
      },
      getReadFileCache: () => readFileCache,
      setReadFileCache: c => {
        readFileCache = c
      },
      abortController,
      userSpecifiedModel: llm.model,
      includePartialMessages: true,
      thinkingConfig: { type: 'auto' },
    })) {
      if (signal.aborted) {
        yield { type: 'error', message: 'Turn aborted' }
        return
      }
      for (const ev of mapper.map(sdkMsg)) {
        if (ev.type === 'done') sawDone = true
        if (ev.type === 'error') sawError = true
        yield ev
      }
    }
  } catch (e: unknown) {
    if (signal.aborted) {
      yield { type: 'error', message: 'Turn aborted' }
      return
    }
    const message = e instanceof Error ? e.message : String(e)
    yield { type: 'error', message }
    yield { type: 'done', messageId: crypto.randomUUID() }
    return
  } finally {
    if (!signal.aborted) {
      try {
        await drainExtractMemories()
      } catch {
        // best-effort — extraction must not fail the turn
      }
    }
  }

  if (signal.aborted) {
    yield { type: 'error', message: 'Turn aborted' }
    return
  }
  if (!sawDone && !sawError) {
    yield { type: 'done', messageId: crypto.randomUUID() }
  }
}
