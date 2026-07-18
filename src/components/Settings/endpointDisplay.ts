import type { EndpointMode } from '../../utils/ollama/endpointSwitch.js'

export function endpointDisplayValue(mode: EndpointMode | undefined): string {
  switch (mode) {
    case 'ollama-local':
      return 'Local Ollama'
    case 'ollama-remote':
      return 'Remote Ollama'
    case 'cloud':
    default:
      return 'Cloud'
  }
}
