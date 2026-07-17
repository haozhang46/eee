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

/**
 * Every turn must end with a terminal JSONL event (`error` or `done`) so
 * Control CcbSlot can settle. Abort mid-fetch throws; we still emit `error`.
 */
export function turnFailureTerminalEvents(
  turnId: string,
  aborted: boolean,
  err: unknown,
): Array<Record<string, unknown>> {
  if (aborted) {
    return [{ type: 'error', message: 'Turn aborted', id: turnId }]
  }
  const message = err instanceof Error ? err.message : String(err)
  return [
    { type: 'error', message, id: turnId },
    { type: 'done', messageId: crypto.randomUUID(), id: turnId },
  ]
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
      for (const ev of turnFailureTerminalEvents(turn.id, ac.signal.aborted, e)) {
        writeEvent(ev)
      }
    } finally {
      abortById.delete(turn.id)
    }
  }
}

if (import.meta.main) {
  await runStdioBridgeMain()
}
