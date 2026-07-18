import { describe, expect, test } from 'bun:test'
import { fetchOllamaModelNames } from '../tags.ts'

describe('fetchOllamaModelNames', () => {
  test('parses model names from tags response', async () => {
    const names = await fetchOllamaModelNames('http://127.0.0.1:11434', {
      fetch: (async () =>
        new Response(
          JSON.stringify({
            models: [{ name: 'qwen2.5:7b' }, { name: 'llama3:8b' }],
          }),
          { status: 200 },
        )) as typeof fetch,
    })
    expect(names).toEqual(['qwen2.5:7b', 'llama3:8b'])
  })

  test('throws on non-OK', async () => {
    await expect(
      fetchOllamaModelNames('http://127.0.0.1:11434', {
        fetch: (async () => new Response('nope', { status: 500 })) as typeof fetch,
      }),
    ).rejects.toThrow(/500|Ollama|tags/i)
  })
})
