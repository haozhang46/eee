import { tagsUrlFromOrigin } from './url.ts'

type TagsResponse = { models?: Array<{ name?: string }> }

export async function fetchOllamaModelNames(
  origin: string,
  init?: { fetch?: typeof fetch; apiKey?: string },
): Promise<string[]> {
  const fetchFn = init?.fetch ?? globalThis.fetch
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (init?.apiKey) headers.Authorization = `Bearer ${init.apiKey}`
  let res: Response
  try {
    res = await fetchFn(tagsUrlFromOrigin(origin), { headers })
  } catch (e) {
    throw new Error(
      `Cannot reach Ollama at ${origin}. Is it running? (${e instanceof Error ? e.message : String(e)})`,
    )
  }
  if (!res.ok) {
    throw new Error(`Ollama tags request failed (${res.status})`)
  }
  const data = (await res.json()) as TagsResponse
  const names = (data.models ?? [])
    .map(m => m.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
  return names
}
