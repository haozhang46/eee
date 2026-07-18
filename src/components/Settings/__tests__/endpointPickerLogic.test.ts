import { describe, expect, test } from 'bun:test'
import { endpointDisplayValue } from '../endpointDisplay.ts'

describe('endpointDisplayValue', () => {
  test('maps modes to labels; unset defaults to Cloud', () => {
    expect(endpointDisplayValue(undefined)).toBe('Cloud')
    expect(endpointDisplayValue('cloud')).toBe('Cloud')
    expect(endpointDisplayValue('ollama-local')).toBe('Local Ollama')
    expect(endpointDisplayValue('ollama-remote')).toBe('Remote Ollama')
  })
})
