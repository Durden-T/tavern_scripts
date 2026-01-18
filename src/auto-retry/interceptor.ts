import { useSettingsStore } from './settings';
import { executeWithRetry, updateTokenTime, abortRetry, getActiveContext } from './retry-engine';

let originalGenerate: typeof generate | null = null;
let originalGenerateRaw: typeof generateRaw | null = null;
let streamingListener: EventOnReturn | null = null;
let generationStoppedListener: EventOnReturn | null = null;
let installed = false;

export function install(): void {
  if (installed) return;

  originalGenerate = generate;
  originalGenerateRaw = generateRaw;

  (window as unknown as { generate: typeof generate }).generate = wrappedGenerate;
  (window as unknown as { generateRaw: typeof generateRaw }).generateRaw = wrappedGenerateRaw;

  streamingListener = eventOn(iframe_events.STREAM_TOKEN_RECEIVED_FULLY, (_text, generationId) => {
    updateTokenTime(generationId);
  });

  generationStoppedListener = eventOn(tavern_events.GENERATION_STOPPED, () => {
    // User manually stopped - we don't know which generation, so we stop all active retries
  });

  installed = true;
  console.info('[auto-retry] Interceptor installed');
}

export function uninstall(): void {
  if (!installed) return;

  if (originalGenerate) {
    (window as unknown as { generate: typeof generate }).generate = originalGenerate;
    originalGenerate = null;
  }

  if (originalGenerateRaw) {
    (window as unknown as { generateRaw: typeof generateRaw }).generateRaw = originalGenerateRaw;
    originalGenerateRaw = null;
  }

  if (streamingListener) {
    streamingListener.stop();
    streamingListener = null;
  }

  if (generationStoppedListener) {
    generationStoppedListener.stop();
    generationStoppedListener = null;
  }

  installed = false;
  console.info('[auto-retry] Interceptor uninstalled');
}

async function wrappedGenerate(config: GenerateConfig): Promise<string> {
  const store = useSettingsStore();

  if (!store.settings.enabled || !originalGenerate) {
    return originalGenerate!(config);
  }

  const result = await executeWithRetry(
    () => originalGenerate!(config),
    config,
    store.settings,
    originalGenerate!,
    originalGenerateRaw!,
    false,
  );

  if (result.success) {
    return result.result as string;
  }

  throw result.error;
}

async function wrappedGenerateRaw(config: GenerateRawConfig): Promise<string> {
  const store = useSettingsStore();

  if (!store.settings.enabled || !originalGenerateRaw) {
    return originalGenerateRaw!(config);
  }

  const result = await executeWithRetry(
    () => originalGenerateRaw!(config),
    config,
    store.settings,
    originalGenerate!,
    originalGenerateRaw!,
    true,
  );

  if (result.success) {
    return result.result as string;
  }

  throw result.error;
}

export function abortGenerationRetry(generationId: string): boolean {
  return abortRetry(generationId);
}

export function isRetrying(generationId: string): boolean {
  return getActiveContext(generationId) !== undefined;
}
