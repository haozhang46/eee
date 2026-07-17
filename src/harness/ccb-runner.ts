/**
 * Slot agent runner — uses CCB's real tool implementations via tool.call().
 * Streaming via direct API call, tool execution via CCB's Tool instances.
 *
 * SlotEvent-like shapes are duplicated locally (do not import @harness/slot).
 */
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { formatToolResult } from './formatToolResult.js'

/** Minimal SlotEvent shapes compatible with @harness/slot (duplicated on purpose). */
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

interface LLMSettings {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
}

interface OpenAIMessage {
  role: string
  content: string | null
  tool_calls?: Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
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

function toolToOpenAI(tool: {
  name: string
  inputSchema?: { _def?: unknown; shape?: unknown }
  userFacingName?: (input: string) => string
}): {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
} {
  try {
    const schema = tool.inputSchema?._def ?? tool.inputSchema
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.userFacingName?.('') ?? tool.name,
        parameters:
          schema &&
          typeof schema === 'object' &&
          'shape' in schema &&
          schema.shape
            ? zSchema(schema)
            : { type: 'object', properties: {} },
      },
    }
  } catch {
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.name,
        parameters: { type: 'object', properties: {} },
      },
    }
  }
}

function zSchema(s: { shape?: Record<string, unknown> }): {
  type: string
  properties: Record<string, unknown>
} {
  try {
    const shape = s.shape ?? (s as unknown as Record<string, unknown>)
    const props: Record<string, unknown> = {}
    for (const [k, d] of Object.entries(shape)) {
      const t: Record<string, unknown> = {}
      const dn =
        (d as { _def?: { typeName?: string; description?: string } })?._def
          ?.typeName ?? ''
      t.type =
        (
          {
            ZodString: 'string',
            ZodNumber: 'number',
            ZodBoolean: 'boolean',
            ZodArray: 'array',
            ZodObject: 'object',
            ZodEnum: 'string',
          } as Record<string, string>
        )[dn] ?? 'string'
      const desc = (d as { _def?: { description?: string } })?._def?.description
      if (desc) t.description = desc
      props[k] = t
    }
    return { type: 'object', properties: props }
  } catch {
    return { type: 'object', properties: {} }
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

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof Error && e.name === 'AbortError') ||
    (typeof DOMException !== 'undefined' &&
      e instanceof DOMException &&
      e.name === 'AbortError')
  )
}

export async function* runCCBAgent(
  messages: Array<{ role: string; content: string }>,
  workspaceRoot: string,
  signal: AbortSignal,
): AsyncGenerator<SlotEvent> {
  const llm = loadLLM(workspaceRoot)
  if (!llm.apiKey) {
    yield {
      type: 'text-delta',
      content: 'Please configure your LLM API key in Settings first.\n',
    }
    yield { type: 'done', messageId: crypto.randomUUID() }
    return
  }
  if (llm.provider === 'openai') {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_MODEL = llm.model
    process.env.OPENAI_BASE_URL = llm.baseUrl
    process.env.OPENAI_API_KEY = llm.apiKey
  }

  const [
    { enableConfigs },
    { getTools },
    { FileStateCache },
    { hasPermissionsToUseTool },
  ] = await Promise.all([
    import('../utils/config.js'),
    import('../tools.js'),
    import('../utils/fileStateCache.js'),
    import('../utils/permissions/permissions.js'),
  ])
  enableConfigs()
  const pc = {
    mode: 'default' as const,
    alwaysAllowRules: {} as Record<string, unknown>,
    alwaysDenyRules: {} as Record<string, unknown>,
    alwaysAskRules: {} as Record<string, unknown>,
    shouldAvoidPermissionPrompts: false,
  }
  // getTools includes WebSearch and other builtin tools.
  const ccbTools = getTools(pc as never)

  const abortController = new AbortController()
  linkAbortSignal(signal, abortController)

  const ctx = {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: llm.model,
      tools: ccbTools,
      verbose: false,
      thinkingConfig: { type: 'auto' as const },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { agents: [], commands: [], skills: [] },
    },
    abortController,
    readFileState: new FileStateCache(1000, 10 * 1024 * 1024),
    getAppState: () => ({ toolPermissionContext: pc }),
    setAppState: () => {},
  }

  const functions = ccbTools.slice(0, 25).map(toolToOpenAI)
  const toolMap = new Map(ccbTools.map(t => [t.name, t]))
  // Avoid contaminating Chat JSONL stdout — log to stderr.
  console.error(`[harness:runner] ${functions.length} CCB tools loaded`)

  const baseUrl = llm.baseUrl.replace(/\/+$/, '')
  const url = `${baseUrl}/chat/completions`
  const apiMessages: OpenAIMessage[] = messages.map(m => ({
    role: m.role,
    content: m.content,
  }))

  for (let round = 0; round < 5; round++) {
    if (signal.aborted) {
      yield { type: 'error', message: 'Turn aborted' }
      return
    }
    let responseText = ''
    const tcIndex = new Map<
      number,
      { id: string; name: string; args: string }
    >()

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify({
          model: llm.model,
          messages: apiMessages,
          tools: functions,
          stream: true,
        }),
        signal,
      })
    } catch (e: unknown) {
      if (signal.aborted || isAbortError(e)) {
        yield { type: 'error', message: 'Turn aborted' }
        return
      }
      throw e
    }
    if (!response.ok) {
      yield { type: 'error', message: `API ${response.status}` }
      return
    }
    const reader = response.body?.getReader()
    if (!reader) {
      yield { type: 'error', message: 'No stream' }
      return
    }
    const decoder = new TextDecoder()
    let buf = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') continue
          try {
            const json = JSON.parse(data) as {
              choices?: Array<{
                delta?: {
                  content?: string
                  tool_calls?: Array<{
                    index?: number
                    id?: string
                    function?: { name?: string; arguments?: string }
                  }>
                }
              }>
            }
            const delta = json.choices?.[0]?.delta
            if (delta?.content) {
              responseText += delta.content
              yield { type: 'text-delta', content: delta.content }
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                const ex = tcIndex.get(idx) ?? {
                  id: tc.id ?? crypto.randomUUID(),
                  name: '',
                  args: '',
                }
                if (tc.id) ex.id = tc.id
                if (tc.function?.name) ex.name = tc.function.name
                if (tc.function?.arguments) ex.args += tc.function.arguments
                tcIndex.set(idx, ex)
              }
            }
          } catch {
            // ignore malformed SSE chunks
          }
        }
      }
    } catch (e: unknown) {
      if (signal.aborted || isAbortError(e)) {
        yield { type: 'error', message: 'Turn aborted' }
        return
      }
      throw e
    }

    if (tcIndex.size === 0) {
      yield { type: 'done', messageId: crypto.randomUUID() }
      return
    }

    const assistantMsg: OpenAIMessage = {
      role: 'assistant',
      content: responseText || null,
      tool_calls: [],
    }
    apiMessages.push(assistantMsg)
    for (const [, tc] of tcIndex) {
      if (signal.aborted) {
        yield { type: 'error', message: 'Turn aborted' }
        return
      }
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.args) as Record<string, unknown>
      } catch {
        args = {}
      }
      yield {
        type: 'tool-call',
        toolCall: {
          id: tc.id,
          toolName: tc.name,
          input: args,
          status: 'running',
        },
      }

      const ccbTool = toolMap.get(tc.name)
      let result: string
      if (ccbTool?.call) {
        try {
          const parsed =
            ccbTool.inputSchema &&
            typeof ccbTool.inputSchema === 'object' &&
            'parse' in ccbTool.inputSchema &&
            typeof ccbTool.inputSchema.parse === 'function'
              ? ccbTool.inputSchema.parse(args)
              : args
          const r = await ccbTool.call(
            parsed,
            ctx as never,
            hasPermissionsToUseTool as never,
            {} as never,
          )
          result = formatToolResult(ccbTool, r, tc.id)
        } catch (e: unknown) {
          if (signal.aborted || isAbortError(e)) {
            yield { type: 'error', message: 'Turn aborted' }
            return
          }
          const msg = e instanceof Error ? e.message : String(e)
          result = `Tool error: ${msg}`
        }
      } else {
        result = `Tool "${tc.name}" not available (CCB tool not found)`
      }

      yield {
        type: 'tool-call',
        toolCall: {
          id: tc.id,
          toolName: tc.name,
          input: args,
          output: result.slice(0, 4000),
          status: 'complete',
        },
      }
      assistantMsg.tool_calls ??= []
      assistantMsg.tool_calls.push({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.args },
      })
      apiMessages.push({
        role: 'tool',
        content: result.slice(0, 8000),
        tool_call_id: tc.id,
      })
    }
  }

  if (signal.aborted) {
    yield { type: 'error', message: 'Turn aborted' }
    return
  }
  yield { type: 'done', messageId: crypto.randomUUID() }
}
