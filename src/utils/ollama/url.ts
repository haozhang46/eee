export const LOCAL_OLLAMA_ORIGIN = 'http://127.0.0.1:11434'

export function normalizeOllamaOrigin(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Ollama URL is required')
  const withScheme = trimmed.includes('://') ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`Invalid Ollama URL: ${input}`)
  }
  return url.origin
}

export function toOpenAiCompatibleBaseUrl(originOrUrl: string): string {
  const origin = normalizeOllamaOrigin(originOrUrl)
  return `${origin}/v1`
}

export function tagsUrlFromOrigin(origin: string): string {
  return `${normalizeOllamaOrigin(origin)}/api/tags`
}
