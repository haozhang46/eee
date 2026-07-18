import {
  LOCAL_OLLAMA_ORIGIN,
  normalizeOllamaOrigin,
  toOpenAiCompatibleBaseUrl,
} from './url.ts'

export type EndpointMode = 'cloud' | 'ollama-local' | 'ollama-remote'

export type CloudEndpointSnapshot = {
  modelType?: 'anthropic' | 'openai' | 'gemini' | 'grok'
  env?: Record<string, string>
}

const OPENAI_ENV_KEYS = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
] as const

export function openaiEnvKeysToClear(): string[] {
  return [...OPENAI_ENV_KEYS]
}

export function shouldSaveCloudSnapshot(
  currentMode: EndpointMode | undefined,
): boolean {
  return currentMode === undefined || currentMode === 'cloud'
}

function buildOpenAiOllamaEnv(
  baseUrl: string,
  apiKey: string,
  modelName: string,
): Record<string, string> {
  return {
    OPENAI_BASE_URL: baseUrl,
    OPENAI_API_KEY: apiKey,
    OPENAI_MODEL: modelName,
    OPENAI_DEFAULT_HAIKU_MODEL: modelName,
    OPENAI_DEFAULT_SONNET_MODEL: modelName,
    OPENAI_DEFAULT_OPUS_MODEL: modelName,
  }
}

export function buildOllamaSettingsPatch(args: {
  mode: 'ollama-local' | 'ollama-remote'
  modelName: string
  remoteOrigin?: string
  apiKey?: string
  previous: {
    endpointMode?: EndpointMode
    modelType?: string
    env?: Record<string, string>
    cloudEndpointSnapshot?: CloudEndpointSnapshot
  }
}): Record<string, unknown> {
  const { mode, modelName, remoteOrigin, apiKey, previous } = args

  const origin =
    mode === 'ollama-local'
      ? LOCAL_OLLAMA_ORIGIN
      : normalizeOllamaOrigin(remoteOrigin ?? '')
  const openAiBaseUrl = toOpenAiCompatibleBaseUrl(origin)
  const resolvedApiKey = apiKey ?? 'ollama'

  const patch: Record<string, unknown> = {
    endpointMode: mode,
    modelType: 'openai',
    env: buildOpenAiOllamaEnv(openAiBaseUrl, resolvedApiKey, modelName),
  }

  if (mode === 'ollama-remote') {
    patch.ollamaRemoteBaseUrl = origin
  }

  if (shouldSaveCloudSnapshot(previous.endpointMode)) {
    patch.cloudEndpointSnapshot = {
      modelType: previous.modelType,
      env: previous.env,
    }
  } else if (previous.cloudEndpointSnapshot) {
    patch.cloudEndpointSnapshot = previous.cloudEndpointSnapshot
  }

  return patch
}

export function buildCloudRestorePatch(
  snapshot: CloudEndpointSnapshot | undefined,
):
  | { ok: true; patch: Record<string, unknown> }
  | { ok: false; reason: 'no_snapshot' } {
  if (!snapshot) {
    return { ok: false, reason: 'no_snapshot' }
  }

  return {
    ok: true,
    patch: {
      endpointMode: 'cloud',
      modelType: snapshot.modelType,
      env: snapshot.env,
    },
  }
}

export function applyOpenAiEnvToProcess(
  env: Record<string, string | undefined>,
): void {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}
