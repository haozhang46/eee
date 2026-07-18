import { describe, expect, test } from 'bun:test'
import {
  LOCAL_OLLAMA_ORIGIN,
  normalizeOllamaOrigin,
  toOpenAiCompatibleBaseUrl,
  tagsUrlFromOrigin,
} from '../url.ts'

describe('normalizeOllamaOrigin', () => {
  test('prepends http:// when scheme missing', () => {
    expect(normalizeOllamaOrigin('192.168.1.10:11434')).toBe(
      'http://192.168.1.10:11434',
    )
  })
  test('returns origin only', () => {
    expect(normalizeOllamaOrigin('http://host:11434/v1')).toBe(
      'http://host:11434',
    )
  })
})

describe('toOpenAiCompatibleBaseUrl', () => {
  test('appends /v1', () => {
    expect(toOpenAiCompatibleBaseUrl(LOCAL_OLLAMA_ORIGIN)).toBe(
      'http://127.0.0.1:11434/v1',
    )
  })
  test('does not double /v1', () => {
    expect(toOpenAiCompatibleBaseUrl('http://127.0.0.1:11434/v1')).toBe(
      'http://127.0.0.1:11434/v1',
    )
  })
})

describe('tagsUrlFromOrigin', () => {
  test('uses /api/tags on origin', () => {
    expect(tagsUrlFromOrigin(LOCAL_OLLAMA_ORIGIN)).toBe(
      'http://127.0.0.1:11434/api/tags',
    )
  })
})
