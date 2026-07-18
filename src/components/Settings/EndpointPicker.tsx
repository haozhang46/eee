import { Box, Text } from '@anthropic/ink';
import * as React from 'react';
import { useCallback, useRef, useState } from 'react';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { clearOpenAIClientCache } from '../../services/api/openai/client.js';
import {
  applyOpenAiEnvToProcess,
  buildCloudRestorePatch,
  buildOllamaSettingsPatch,
  openaiEnvKeysToClear,
} from '../../utils/ollama/endpointSwitch.js';
import { fetchOllamaModelNames } from '../../utils/ollama/tags.js';
import { LOCAL_OLLAMA_ORIGIN, normalizeOllamaOrigin } from '../../utils/ollama/url.js';
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js';
import type { SettingsJson } from '../../utils/settings/types.js';
import { Select } from '../CustomSelect/index.js';
import TextInput from '../TextInput.js';

export { endpointDisplayValue } from './endpointDisplay.js';

export type EndpointPickerProps = {
  onDone: (message: string) => void;
  onCancel: () => void;
};

type FlowState = 'choose' | 'remote_url' | 'remote_key' | 'loading_models' | 'pick_model';

const MODE_OPTIONS = [
  {
    value: 'cloud',
    label: 'Cloud',
    description: 'Restore the cloud provider saved before switching to Ollama',
  },
  {
    value: 'ollama-local',
    label: 'Local Ollama',
    description: 'http://127.0.0.1:11434 — list models from this machine',
  },
  {
    value: 'ollama-remote',
    label: 'Remote Ollama',
    description: 'Enter a remote Ollama Base URL, then pick a model',
  },
] as const;

function clearedOpenAiEnv(snapshotEnv?: Record<string, string>): Record<string, string | undefined> {
  const cleared: Record<string, string | undefined> = {};
  for (const key of openaiEnvKeysToClear()) {
    cleared[key] = undefined;
  }
  return { ...cleared, ...snapshotEnv };
}

function isOllamaEndpointMode(mode: SettingsJson['endpointMode']): boolean {
  return mode === 'ollama-local' || mode === 'ollama-remote';
}

export function EndpointPicker({ onDone, onCancel }: EndpointPickerProps): React.ReactNode {
  const userSettings = getSettingsForSource('userSettings');
  const [flow, setFlow] = useState<FlowState>('choose');
  const [pendingMode, setPendingMode] = useState<'ollama-local' | 'ollama-remote' | null>(null);
  const [remoteUrl, setRemoteUrl] = useState(userSettings?.ollamaRemoteBaseUrl ?? '');
  const [remoteUrlCursor, setRemoteUrlCursor] = useState((userSettings?.ollamaRemoteBaseUrl ?? '').length);
  const [remoteApiKey, setRemoteApiKey] = useState('');
  const [remoteApiKeyCursor, setRemoteApiKeyCursor] = useState(0);
  const [remoteOrigin, setRemoteOrigin] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Bumped on cancel / new fetch so late tags responses cannot change flow.
  const fetchGenerationRef = useRef(0);

  const handleBackOrCancel = useCallback(() => {
    if (flow === 'choose') {
      onCancel();
      return;
    }
    setError(null);
    setStatus(null);
    if (flow === 'remote_url' || flow === 'remote_key') {
      setFlow('choose');
      setPendingMode(null);
      return;
    }
    if (flow === 'loading_models' || flow === 'pick_model') {
      if (flow === 'loading_models') {
        fetchGenerationRef.current += 1;
      }
      if (pendingMode === 'ollama-remote') {
        setFlow('remote_key');
      } else {
        setFlow('choose');
        setPendingMode(null);
      }
      return;
    }
    onCancel();
  }, [flow, onCancel, pendingMode]);

  // Select screens handle Esc via onCancel; only bind Esc for text/loading steps.
  useKeybinding('confirm:no', handleBackOrCancel, {
    context: 'Settings',
    isActive: flow === 'remote_url' || flow === 'remote_key' || flow === 'loading_models',
  });

  const applyCloud = useCallback(() => {
    const snapshot = userSettings?.cloudEndpointSnapshot;
    const result = buildCloudRestorePatch(snapshot);
    if (!result.ok) {
      // Spec: already cloud + no snapshot → silent no-op (do not mark Config dirty).
      // On Ollama without snapshot → message via onDone (still no settings write).
      if (isOllamaEndpointMode(userSettings?.endpointMode)) {
        onDone('No cloud endpoint saved. Run /login first to configure a cloud provider.');
      } else {
        onCancel();
      }
      return;
    }

    const env = clearedOpenAiEnv(snapshot?.env);
    const patch = {
      ...result.patch,
      env,
    } as SettingsJson;

    const { error: writeError } = updateSettingsForSource('userSettings', patch);
    if (writeError) {
      setError(`Failed to save settings: ${writeError.message}`);
      setFlow('choose');
      return;
    }

    applyOpenAiEnvToProcess(env);
    clearOpenAIClientCache();
    onDone('Switched to Cloud');
  }, [onCancel, onDone, userSettings?.cloudEndpointSnapshot, userSettings?.endpointMode]);

  const applyOllama = useCallback(
    (modelName: string) => {
      if (!pendingMode) return;
      const previous = getSettingsForSource('userSettings') ?? {};
      let patch: Record<string, unknown>;
      try {
        patch = buildOllamaSettingsPatch({
          mode: pendingMode,
          modelName,
          remoteOrigin: pendingMode === 'ollama-remote' ? (remoteOrigin ?? undefined) : undefined,
          apiKey: pendingMode === 'ollama-remote' ? remoteApiKey.trim() || 'ollama' : undefined,
          previous: {
            endpointMode: previous.endpointMode,
            modelType: previous.modelType,
            env: previous.env,
            cloudEndpointSnapshot: previous.cloudEndpointSnapshot,
          },
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setFlow(pendingMode === 'ollama-remote' ? 'remote_url' : 'choose');
        return;
      }

      const { error: writeError } = updateSettingsForSource('userSettings', patch as SettingsJson);
      if (writeError) {
        setError(`Failed to save settings: ${writeError.message}`);
        setFlow('pick_model');
        return;
      }

      const env = patch.env as Record<string, string>;
      applyOpenAiEnvToProcess(env);
      clearOpenAIClientCache();
      const label = pendingMode === 'ollama-local' ? 'Local Ollama' : 'Remote Ollama';
      onDone(`Switched to ${label} (${modelName})`);
    },
    [onDone, pendingMode, remoteApiKey, remoteOrigin],
  );

  const startModelFetch = useCallback(
    async (mode: 'ollama-local' | 'ollama-remote', origin: string, apiKey?: string) => {
      const generation = ++fetchGenerationRef.current;
      setPendingMode(mode);
      setRemoteOrigin(origin);
      setFlow('loading_models');
      setError(null);
      setStatus(mode === 'ollama-local' ? 'Fetching models from local Ollama…' : `Fetching models from ${origin}…`);
      setModels([]);
      try {
        const names = await fetchOllamaModelNames(origin, {
          apiKey: apiKey?.trim() || undefined,
        });
        if (generation !== fetchGenerationRef.current) return;
        if (names.length === 0) {
          setError('No models found. Run `ollama pull <model>` first, then try again.');
          setStatus(null);
          setFlow(mode === 'ollama-remote' ? 'remote_key' : 'choose');
          return;
        }
        setModels(names);
        setStatus(null);
        setFlow('pick_model');
      } catch (e) {
        if (generation !== fetchGenerationRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus(null);
        setFlow(mode === 'ollama-remote' ? 'remote_url' : 'choose');
      }
    },
    [],
  );

  const handleModeSelect = useCallback(
    (value: string) => {
      setError(null);
      setStatus(null);
      if (value === 'cloud') {
        applyCloud();
        return;
      }
      if (value === 'ollama-local') {
        void startModelFetch('ollama-local', LOCAL_OLLAMA_ORIGIN);
        return;
      }
      if (value === 'ollama-remote') {
        setPendingMode('ollama-remote');
        setFlow('remote_url');
      }
    },
    [applyCloud, startModelFetch],
  );

  const handleRemoteUrlSubmit = useCallback(() => {
    setError(null);
    try {
      const origin = normalizeOllamaOrigin(remoteUrl);
      setRemoteOrigin(origin);
      setRemoteUrl(origin);
      setFlow('remote_key');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [remoteUrl]);

  const handleRemoteKeySubmit = useCallback(() => {
    if (!remoteOrigin) {
      setError('Base URL is required');
      setFlow('remote_url');
      return;
    }
    void startModelFetch('ollama-remote', remoteOrigin, remoteApiKey.trim() || 'ollama');
  }, [remoteApiKey, remoteOrigin, startModelFetch]);

  if (flow === 'remote_url') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="remember">
          Remote Ollama
        </Text>
        <Text dimColor>Enter the Ollama Base URL (scheme optional)</Text>
        <Box flexDirection="row" gap={1}>
          <Text>Base URL:</Text>
          <TextInput
            value={remoteUrl}
            onChange={setRemoteUrl}
            onSubmit={handleRemoteUrlSubmit}
            focus={true}
            showCursor={true}
            placeholder="http://192.168.1.10:11434"
            columns={50}
            cursorOffset={remoteUrlCursor}
            onChangeCursorOffset={setRemoteUrlCursor}
          />
        </Box>
        {error ? <Text color="error">{error}</Text> : null}
        <Text dimColor>Enter to continue · Esc to go back</Text>
      </Box>
    );
  }

  if (flow === 'remote_key') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="remember">
          Remote Ollama
        </Text>
        <Text dimColor>Optional API key for {remoteOrigin ?? 'remote'} (empty → ollama)</Text>
        <Box flexDirection="row" gap={1}>
          <Text>API Key:</Text>
          <TextInput
            value={remoteApiKey}
            onChange={setRemoteApiKey}
            onSubmit={handleRemoteKeySubmit}
            focus={true}
            showCursor={true}
            columns={40}
            mask="*"
            cursorOffset={remoteApiKeyCursor}
            onChangeCursorOffset={setRemoteApiKeyCursor}
          />
        </Box>
        {error ? <Text color="error">{error}</Text> : null}
        <Text dimColor>Enter to fetch models · Esc to go back</Text>
      </Box>
    );
  }

  if (flow === 'loading_models') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="remember">
          Select endpoint
        </Text>
        <Text dimColor>{status ?? 'Loading models…'}</Text>
        {error ? <Text color="error">{error}</Text> : null}
        <Text dimColor>Esc to go back</Text>
      </Box>
    );
  }

  if (flow === 'pick_model') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="remember">
          Select Ollama model
        </Text>
        <Text dimColor>{pendingMode === 'ollama-local' ? 'Local Ollama models' : `Models at ${remoteOrigin}`}</Text>
        <Select
          options={models.map(name => ({ value: name, label: name }))}
          onChange={applyOllama}
          onCancel={handleBackOrCancel}
          visibleOptionCount={Math.min(10, models.length)}
          defaultValue={models[0]}
        />
        {error ? <Text color="error">{error}</Text> : null}
        <Text dimColor>Enter to apply · Esc to go back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="remember">
        Select endpoint
      </Text>
      <Text dimColor>Switch between cloud provider and local/remote Ollama (OpenAI-compatible)</Text>
      <Select
        options={[...MODE_OPTIONS]}
        onChange={handleModeSelect}
        onCancel={onCancel}
        visibleOptionCount={3}
        defaultValue={userSettings?.endpointMode ?? 'cloud'}
      />
      {error ? <Text color="error">{error}</Text> : null}
      <Text dimColor>Enter to select · Esc to cancel</Text>
    </Box>
  );
}
