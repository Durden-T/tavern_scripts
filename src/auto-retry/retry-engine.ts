import { uuidv4 } from '@util/common';
import type { FallbackModel, Settings } from './settings';

export type RetryableFunction<T> = () => Promise<T>;

export interface RetryContext {
  generationId: string;
  isStreaming: boolean;
  config: GenerateConfig | GenerateRawConfig;
  aborted: boolean;
  lastTokenTime: number;
  hasReceivedContent: boolean;
  startTime: number;
}

interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: unknown;
  attempts: number;
  usedFallback: boolean;
  fallbackModel?: FallbackModel;
}

const activeContexts = new Map<string, RetryContext>();

export function getActiveContext(generationId: string): RetryContext | undefined {
  return activeContexts.get(generationId);
}

export function abortRetry(generationId: string): boolean {
  const ctx = activeContexts.get(generationId);
  if (ctx) {
    ctx.aborted = true;
    return true;
  }
  return false;
}

export function updateTokenTime(generationId: string): void {
  const ctx = activeContexts.get(generationId);
  if (ctx) {
    ctx.lastTokenTime = Date.now();
    ctx.hasReceivedContent = true;
  }
}

export function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('quota exceeded')) {
      return true;
    }
  }
  if (typeof error === 'object' && error !== null) {
    const status = (error as Record<string, unknown>).status ?? (error as Record<string, unknown>).statusCode;
    if (status === 429) return true;
  }
  return false;
}

export function isRetryableError(error: unknown): boolean {
  if (isRateLimitError(error)) return true;

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes('network') ||
      msg.includes('fetch') ||
      msg.includes('timeout') ||
      msg.includes('connection refused') ||
      msg.includes('connection reset') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset')
    ) {
      return true;
    }
  }

  if (typeof error === 'object' && error !== null) {
    const status = (error as Record<string, unknown>).status ?? (error as Record<string, unknown>).statusCode;
    if (typeof status === 'number' && status >= 500 && status < 600) {
      return true;
    }
  }

  return false;
}

function validateContent(content: string, settings: Settings): boolean {
  if (!settings.requiredContentEnabled || !settings.requiredContentPattern) {
    return true;
  }

  if (settings.requiredContentIsRegex) {
    try {
      const regex = new RegExp(settings.requiredContentPattern);
      return regex.test(content);
    } catch {
      console.warn('[auto-retry] Invalid regex pattern:', settings.requiredContentPattern);
      return true;
    }
  }

  return content.includes(settings.requiredContentPattern);
}

function calculateDelay(attempt: number, settings: Settings, isRateLimit: boolean): number {
  if (isRateLimit) {
    return settings.rateLimitDelayMs;
  }
  return settings.retryDelayMs * Math.pow(settings.retryDelayMultiplier, attempt - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldRetryGeneration(generationId: string, settings: Settings): boolean {
  if (!settings.filterEnabled) return true;

  const isInList = settings.filterGenerationIds.includes(generationId);

  if (settings.filterMode === 'whitelist') {
    return isInList;
  }
  return !isInList;
}

export async function executeWithRetry<T>(
  fn: RetryableFunction<T>,
  config: GenerateConfig | GenerateRawConfig,
  settings: Settings,
  originalGenerate: (config: GenerateConfig) => Promise<string>,
  originalGenerateRaw: (config: GenerateRawConfig) => Promise<string>,
  isRaw: boolean,
): Promise<RetryResult<T>> {
  const generationId = config.generation_id ?? uuidv4();
  const isStreaming = config.should_stream ?? false;

  if (!shouldRetryGeneration(generationId, settings)) {
    try {
      const result = await fn();
      return { success: true, result, attempts: 1, usedFallback: false };
    } catch (error) {
      return { success: false, error, attempts: 1, usedFallback: false };
    }
  }

  const ctx: RetryContext = {
    generationId,
    isStreaming,
    config,
    aborted: false,
    lastTokenTime: Date.now(),
    hasReceivedContent: false,
    startTime: Date.now(),
  };

  activeContexts.set(generationId, ctx);

  try {
    const result = await executeRetryLoop(fn, config, settings, ctx, originalGenerate, originalGenerateRaw, isRaw);
    return result;
  } finally {
    activeContexts.delete(generationId);
  }
}

async function executeRetryLoop<T>(
  fn: RetryableFunction<T>,
  config: GenerateConfig | GenerateRawConfig,
  settings: Settings,
  ctx: RetryContext,
  originalGenerate: (config: GenerateConfig) => Promise<string>,
  originalGenerateRaw: (config: GenerateRawConfig) => Promise<string>,
  isRaw: boolean,
): Promise<RetryResult<T>> {
  let attempt = 0;
  let lastError: unknown;
  let currentConfig = config;
  let currentFn = fn;
  let usedFallback = false;
  let currentFallbackModel: FallbackModel | undefined;
  let fallbackIndex = -1;

  const maxRetries = settings.maxRetries;

  while (attempt < maxRetries) {
    if (ctx.aborted) {
      return { success: false, error: new Error('Aborted by user'), attempts: attempt, usedFallback };
    }

    attempt++;
    ctx.lastTokenTime = Date.now();
    ctx.hasReceivedContent = false;
    ctx.startTime = Date.now();

    if (settings.showRetryToast && attempt > 1) {
      toastr.info(`Auto-retry: Attempt ${attempt}/${maxRetries}...`);
    }

    try {
      const resultPromise = currentFn();
      const result = await raceWithTimeouts(resultPromise, ctx, settings);

      if (typeof result === 'string' && !validateContent(result, settings)) {
        if (settings.showRetryToast) {
          toastr.warning('Response missing required content. Retrying...');
        }
        lastError = new Error('Content validation failed');
        await handleRetryDelay(attempt, settings, false);
        continue;
      }

      if (settings.showSuccessToast && attempt > 1) {
        toastr.success(`Auto-retry succeeded on attempt ${attempt}`);
      }

      return { success: true, result: result as T, attempts: attempt, usedFallback, fallbackModel: currentFallbackModel };
    } catch (error) {
      lastError = error;
      console.warn(`[auto-retry] Attempt ${attempt} failed:`, error);

      if (ctx.aborted) {
        return { success: false, error: new Error('Aborted by user'), attempts: attempt, usedFallback };
      }

      if (!isRetryableError(error)) {
        break;
      }

      const isRateLimit = isRateLimitError(error);
      const currentMaxRetries = isRateLimit ? settings.rateLimitMaxRetries : maxRetries;

      if (attempt >= currentMaxRetries) {
        break;
      }

      if (isRateLimit && settings.showRetryToast) {
        const seconds = Math.round(settings.rateLimitDelayMs / 1000);
        toastr.warning(`Rate limited. Waiting ${seconds}s...`);
      }

      await handleRetryDelay(attempt, settings, isRateLimit);
    }
  }

  if (settings.fallbackModelsEnabled && settings.fallbackModels.length > 0) {
    for (let i = 0; i < settings.fallbackModels.length; i++) {
      const fallbackModel = settings.fallbackModels[i];

      if (!fallbackModel.apiurl || !fallbackModel.model) {
        console.warn(`[auto-retry] Skipping invalid fallback model at index ${i}`);
        continue;
      }

      fallbackIndex = i;
      usedFallback = true;
      currentFallbackModel = fallbackModel;

      if (settings.showRetryToast) {
        toastr.info(`Trying fallback model: ${fallbackModel.model}...`);
      }

      const fallbackConfig: GenerateConfig = {
        ...currentConfig,
        custom_api: {
          apiurl: fallbackModel.apiurl,
          key: fallbackModel.key,
          model: fallbackModel.model,
          source: fallbackModel.source,
        },
      };

      currentConfig = fallbackConfig;
      currentFn = isRaw
        ? () => originalGenerateRaw(fallbackConfig as GenerateRawConfig) as Promise<T>
        : () => originalGenerate(fallbackConfig) as Promise<T>;

      attempt = 0;

      while (attempt < maxRetries) {
        if (ctx.aborted) {
          return { success: false, error: new Error('Aborted by user'), attempts: attempt, usedFallback, fallbackModel: currentFallbackModel };
        }

        attempt++;
        ctx.lastTokenTime = Date.now();
        ctx.hasReceivedContent = false;
        ctx.startTime = Date.now();

        if (settings.showRetryToast && attempt > 1) {
          toastr.info(`Auto-retry (fallback ${fallbackIndex + 1}): Attempt ${attempt}/${maxRetries}...`);
        }

        try {
          const resultPromise = currentFn();
          const result = await raceWithTimeouts(resultPromise, ctx, settings);

          if (typeof result === 'string' && !validateContent(result, settings)) {
            if (settings.showRetryToast) {
              toastr.warning('Response missing required content. Retrying...');
            }
            lastError = new Error('Content validation failed');
            await handleRetryDelay(attempt, settings, false);
            continue;
          }

          if (settings.showSuccessToast) {
            toastr.success(`Auto-retry succeeded with fallback model: ${fallbackModel.model}`);
          }

          return { success: true, result: result as T, attempts: attempt, usedFallback, fallbackModel: currentFallbackModel };
        } catch (error) {
          lastError = error;
          console.warn(`[auto-retry] Fallback ${fallbackIndex + 1} attempt ${attempt} failed:`, error);

          if (ctx.aborted) {
            return { success: false, error: new Error('Aborted by user'), attempts: attempt, usedFallback, fallbackModel: currentFallbackModel };
          }

          if (!isRetryableError(error)) {
            break;
          }

          if (attempt >= maxRetries) {
            break;
          }

          await handleRetryDelay(attempt, settings, isRateLimitError(error));
        }
      }
    }
  }

  if (settings.showFailureToast) {
    toastr.error(`Auto-retry failed after all attempts`);
  }

  return { success: false, error: lastError, attempts: attempt, usedFallback, fallbackModel: currentFallbackModel };
}

async function raceWithTimeouts<T>(
  promise: Promise<T>,
  ctx: RetryContext,
  settings: Settings,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let resolved = false;
    let streamingCheckInterval: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      resolved = true;
      if (streamingCheckInterval) clearInterval(streamingCheckInterval);
    };

    if (ctx.isStreaming) {
      streamingCheckInterval = setInterval(() => {
        if (resolved || ctx.aborted) {
          cleanup();
          return;
        }

        const timeSinceLastToken = Date.now() - ctx.lastTokenTime;
        if (ctx.hasReceivedContent && timeSinceLastToken > settings.streamingTimeoutMs) {
          cleanup();
          stopGenerationById(ctx.generationId).catch(() => {});
          if (settings.showRetryToast) {
            toastr.warning('Streaming timeout. Retrying...');
          }
          reject(new Error('Streaming timeout'));
        }
      }, 1000);
    }

    promise
      .then(result => {
        if (!resolved) {
          cleanup();
          resolve(result);
        }
      })
      .catch(error => {
        if (!resolved) {
          cleanup();
          reject(error);
        }
      });
  });
}

async function handleRetryDelay(attempt: number, settings: Settings, isRateLimit: boolean): Promise<void> {
  const delay = calculateDelay(attempt, settings, isRateLimit);
  await sleep(delay);
}
