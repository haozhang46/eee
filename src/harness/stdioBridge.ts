/**
 * CCB stdio bridge entry for harness Control CcbSlot.
 *
 * Transport split (important):
 * - Chat JSONL uses process stdin/stdout (turn / abort ↔ SlotEvent+id).
 * - Onion authorize/wait_resolve uses HTTP to Control (`HARNESS_CONTROL_URL`).
 * - `HARNESS_CONTROL_MCP=stdio` only gates `getControlMcpClient()` so the
 *   registered BridgeClient is returned — it does NOT mean onion rides stdio.
 */
import { createInterface } from 'node:readline'
import { createHttpControlClient } from './httpOnionClient.js'
import { setControlMcpClient } from './mcpOnionBridge.js'
import { runCCBAgent } from './ccb-runner.js'

type TurnCommand = {
  type: 'turn'
  id: string
  messages: Array<{ role: string; content: string }>
  workspaceRoot: string
}

type AbortCommand = {
  type: 'abort'
  id: string
}

type Inbound = TurnCommand | AbortCommand | { type?: string }

function writeEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

export async function runStdioBridgeMain(): Promise<void> {
  process.env.HARNESS_ONION_MCP = '1'
  process.env.HARNESS_CONTROL_MCP = 'stdio'
  const controlUrl =
    process.env.HARNESS_CONTROL_URL?.trim() || 'http://127.0.0.1:3100'
  setControlMcpClient(createHttpControlClient(controlUrl))

  const abortById = new Map<string, AbortController>()

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let msg: Inbound
    try {
      msg = JSON.parse(trimmed) as Inbound
    } catch {
      continue
    }

    if (msg.type === 'abort' && typeof (msg as AbortCommand).id === 'string') {
      const id = (msg as AbortCommand).id
      abortById.get(id)?.abort()
      abortById.delete(id)
      continue
    }

    if (msg.type !== 'turn') continue
    const turn = msg as TurnCommand
    if (typeof turn.id !== 'string') continue

    const ac = new AbortController()
    abortById.set(turn.id, ac)
    try {
      const messages = Array.isArray(turn.messages) ? turn.messages : []
      const workspaceRoot =
        typeof turn.workspaceRoot === 'string' && turn.workspaceRoot
          ? turn.workspaceRoot
          : process.cwd()
      for await (const ev of runCCBAgent(messages, workspaceRoot, ac.signal)) {
        writeEvent({ ...ev, id: turn.id })
      }
    } catch (e: unknown) {
      if (!ac.signal.aborted) {
        const message = e instanceof Error ? e.message : String(e)
        writeEvent({ type: 'error', message, id: turn.id })
        writeEvent({
          type: 'done',
          messageId: crypto.randomUUID(),
          id: turn.id,
        })
      }
    } finally {
      abortById.delete(turn.id)
    }
  }
}

if (import.meta.main) {
  await runStdioBridgeMain()
}
