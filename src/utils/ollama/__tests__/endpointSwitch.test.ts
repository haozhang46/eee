import { describe, expect, test } from 'bun:test'
import {
  shouldSaveCloudSnapshot,
  buildOllamaSettingsPatch,
  buildCloudRestorePatch,
} from '../endpointSwitch.ts'

describe('shouldSaveCloudSnapshot', () => {
  test('true for cloud and unset', () => {
    expect(shouldSaveCloudSnapshot(undefined)).toBe(true)
    expect(shouldSaveCloudSnapshot('cloud')).toBe(true)
  })
  test('false for ollama modes', () => {
    expect(shouldSaveCloudSnapshot('ollama-local')).toBe(false)
    expect(shouldSaveCloudSnapshot('ollama-remote')).toBe(false)
  })
})

describe('buildOllamaSettingsPatch', () => {
  test('local writes localhost openai env and saves snapshot from cloud', () => {
    const patch = buildOllamaSettingsPatch({
      mode: 'ollama-local',
      modelName: 'qwen2.5:7b',
      previous: {
        endpointMode: 'cloud',
        modelType: 'anthropic',
        env: { ANTHROPIC_API_KEY: 'x' },
      },
    })
    expect(patch.endpointMode).toBe('ollama-local')
    expect(patch.modelType).toBe('openai')
    expect(patch.env).toMatchObject({
      OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
      OPENAI_API_KEY: 'ollama',
      OPENAI_MODEL: 'qwen2.5:7b',
      OPENAI_DEFAULT_HAIKU_MODEL: 'qwen2.5:7b',
      OPENAI_DEFAULT_SONNET_MODEL: 'qwen2.5:7b',
      OPENAI_DEFAULT_OPUS_MODEL: 'qwen2.5:7b',
    })
    expect(patch.cloudEndpointSnapshot).toEqual({
      modelType: 'anthropic',
      env: { ANTHROPIC_API_KEY: 'x' },
    })
  })

  test('remote does not overwrite existing cloud snapshot when switching from local', () => {
    const existing = { modelType: 'anthropic' as const, env: { FOO: '1' } }
    const patch = buildOllamaSettingsPatch({
      mode: 'ollama-remote',
      modelName: 'llama3:8b',
      remoteOrigin: '192.168.1.10:11434',
      apiKey: 'secret',
      previous: {
        endpointMode: 'ollama-local',
        modelType: 'openai',
        env: { OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' },
        cloudEndpointSnapshot: existing,
      },
    })
    expect(patch.cloudEndpointSnapshot).toEqual(existing)
    expect(patch.ollamaRemoteBaseUrl).toBe('http://192.168.1.10:11434')
    expect((patch.env as Record<string, string>).OPENAI_BASE_URL).toBe(
      'http://192.168.1.10:11434/v1',
    )
    expect((patch.env as Record<string, string>).OPENAI_API_KEY).toBe('secret')
  })
})

describe('buildCloudRestorePatch', () => {
  test('restores snapshot', () => {
    const result = buildCloudRestorePatch({
      modelType: 'anthropic',
      env: { ANTHROPIC_API_KEY: 'x' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.patch.endpointMode).toBe('cloud')
      expect(result.patch.modelType).toBe('anthropic')
      expect(result.patch.env).toEqual({ ANTHROPIC_API_KEY: 'x' })
    }
  })
  test('fails without snapshot', () => {
    expect(buildCloudRestorePatch(undefined).ok).toBe(false)
  })
})
