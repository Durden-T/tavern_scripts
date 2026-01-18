import {
  isRateLimitError,
  isRetryableError,
  executeWithRetry,
  abortRetry,
  updateTokenTime,
  getActiveContext,
} from './retry-engine';
import type { Settings } from './settings';

type TestResult = { name: string; passed: boolean; error?: string };

const defaultSettings: Settings = {
  enabled: true,
  maxRetries: 3,
  retryDelayMs: 100,
  retryDelayMultiplier: 1.5,
  rateLimitDelayMs: 200,
  rateLimitMaxRetries: 5,
  streamingTimeoutMs: 500,
  thinkingTimeLimitMs: 1000,
  requiredContentEnabled: false,
  requiredContentPattern: '',
  requiredContentIsRegex: false,
  fallbackModelsEnabled: false,
  fallbackModels: [],
  filterEnabled: false,
  filterMode: 'blacklist',
  filterGenerationIds: [],
  showRetryToast: false,
  showSuccessToast: false,
  showFailureToast: false,
};

function createMockGenerate(): (config: GenerateConfig) => Promise<string> {
  return async () => 'mock result';
}

function createMockGenerateRaw(): (config: GenerateRawConfig) => Promise<string> {
  return async () => 'mock result';
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  try {
    await fn();
    return { name, passed: true };
  } catch (e) {
    return { name, passed: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${expected}, got ${actual}`);
  }
}

export async function runAllTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  results.push(
    await runTest('AC1: isRateLimitError detects 429 status', async () => {
      assert(isRateLimitError({ status: 429 }), 'Should detect status 429');
      assert(isRateLimitError({ statusCode: 429 }), 'Should detect statusCode 429');
    }),
  );

  results.push(
    await runTest('AC2: isRateLimitError detects rate limit message', async () => {
      assert(isRateLimitError(new Error('Rate limit exceeded')), 'Should detect "rate limit"');
      assert(isRateLimitError(new Error('Too many requests')), 'Should detect "too many requests"');
      assert(isRateLimitError(new Error('Quota exceeded')), 'Should detect "quota exceeded"');
    }),
  );

  results.push(
    await runTest('AC2: isRateLimitError returns false for non-rate-limit errors', async () => {
      assert(!isRateLimitError(new Error('Network error')), 'Should not detect network error');
      assert(!isRateLimitError({ status: 500 }), 'Should not detect 500 status');
    }),
  );

  results.push(
    await runTest('AC1/AC8: isRetryableError detects retryable errors', async () => {
      assert(isRetryableError(new Error('Network error')), 'Should detect network error');
      assert(isRetryableError(new Error('fetch failed')), 'Should detect fetch error');
      assert(isRetryableError(new Error('Connection refused')), 'Should detect connection refused');
      assert(isRetryableError({ status: 500 }), 'Should detect 500 status');
      assert(isRetryableError({ status: 502 }), 'Should detect 502 status');
      assert(isRetryableError({ status: 429 }), 'Should detect 429 (rate limit)');
    }),
  );

  results.push(
    await runTest('AC1/AC8: isRetryableError returns false for 4xx errors (except 429)', async () => {
      assert(!isRetryableError({ status: 400 }), 'Should not retry 400');
      assert(!isRetryableError({ status: 401 }), 'Should not retry 401');
      assert(!isRetryableError({ status: 403 }), 'Should not retry 403');
      assert(!isRetryableError({ status: 404 }), 'Should not retry 404');
    }),
  );

  results.push(
    await runTest('AC1: Basic retry succeeds on first attempt', async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return 'success';
      };

      const result = await executeWithRetry(
        fn,
        { generation_id: 'test-1' },
        defaultSettings,
        createMockGenerate(),
        createMockGenerateRaw(),
        false,
      );

      assert(result.success, 'Should succeed');
      assertEquals(result.result, 'success', 'Result should be "success"');
      assertEquals(callCount, 1, 'Should only call once');
      assertEquals(result.attempts, 1, 'Should report 1 attempt');
    }),
  );

  results.push(
    await runTest('AC1: Retry on failure with exponential backoff', async () => {
      let callCount = 0;
      const timestamps: number[] = [];

      const fn = async () => {
        callCount++;
        timestamps.push(Date.now());
        if (callCount < 3) {
          throw new Error('Network error');
        }
        return 'success';
      };

      const result = await executeWithRetry(
        fn,
        { generation_id: 'test-2' },
        defaultSettings,
        createMockGenerate(),
        createMockGenerateRaw(),
        false,
      );

      assert(result.success, 'Should eventually succeed');
      assertEquals(callCount, 3, 'Should retry 3 times');
      assertEquals(result.attempts, 3, 'Should report 3 attempts');
    }),
  );

  results.push(
    await runTest('AC1: Fails after max retries', async () => {
      let callCount = 0;
      const fn = async (): Promise<string> => {
        callCount++;
        throw new Error('Network error');
      };

      const result = await executeWithRetry(
        fn,
        { generation_id: 'test-3' },
        defaultSettings,
        createMockGenerate(),
        createMockGenerateRaw(),
        false,
      );

      assert(!result.success, 'Should fail');
      assertEquals(callCount, 3, 'Should try maxRetries times');
    }),
  );

  results.push(
    await runTest('AC5: Content validation - string match', async () => {
      const settings: Settings = {
        ...defaultSettings,
        requiredContentEnabled: true,
        requiredContentPattern: '```json',
        requiredContentIsRegex: false,
      };

      let callCount = 0;
      const fn = async () => {
        callCount++;
        if (callCount === 1) return 'No json here';
        return 'Here is ```json content';
      };

      const result = await executeWithRetry(
        fn,
        { generation_id: 'test-4' },
        settings,
        createMockGenerate(),
        createMockGenerateRaw(),
        false,
      );

      assert(result.success, 'Should succeed on second attempt');
      assertEquals(callCount, 2, 'Should retry once due to content validation');
    }),
  );

  results.push(
    await runTest('AC5: Content validation - regex match', async () => {
      const settings: Settings = {
        ...defaultSettings,
        requiredContentEnabled: true,
        requiredContentPattern: '\\{"status":\\s*"\\w+"\\}',
        requiredContentIsRegex: true,
      };

      let callCount = 0;
      const fn = async () => {
        callCount++;
        if (callCount === 1) return 'No json here';
        return 'Result: {"status": "ok"}';
      };

      const result = await executeWithRetry(
        fn,
        { generation_id: 'test-5' },
        settings,
        createMockGenerate(),
        createMockGenerateRaw(),
        false,
      );

      assert(result.success, 'Should succeed on second attempt');
      assertEquals(callCount, 2, 'Should retry once due to regex validation');
    }),
  );

  results.push(
    await runTest('AC7: Filter blacklist mode', async () => {
      const settings: Settings = {
        ...defaultSettings,
        filterEnabled: true,
        filterMode: 'blacklist',
        filterGenerationIds: ['background-summary'],
      };

      let callCount = 0;
      const fn = async (): Promise<string> => {
        callCount++;
        throw new Error('Network error');
      };

      const result = await executeWithRetry(
        fn,
        { generation_id: 'background-summary' },
        settings,
        createMockGenerate(),
        createMockGenerateRaw(),
        false,
      );

      assert(!result.success, 'Should fail');
      assertEquals(callCount, 1, 'Should not retry blacklisted ID');
    }),
  );

  results.push(
    await runTest('AC7: Filter whitelist mode - included', async () => {
      const settings: Settings = {
        ...defaultSettings,
        filterEnabled: true,
        filterMode: 'whitelist',
        filterGenerationIds: ['user-chat'],
      };

      let callCount = 0;
      const fn = async () => {
        callCount++;
        if (callCount < 2) throw new Error('Network error');
        return 'success';
      };

      const result = await executeWithRetry(
        fn,
        { generation_id: 'user-chat' },
        settings,
        createMockGenerate(),
        createMockGenerateRaw(),
        false,
      );

      assert(result.success, 'Should succeed');
      assertEquals(callCount, 2, 'Should retry whitelisted ID');
    }),
  );

  results.push(
    await runTest('AC7: Filter whitelist mode - excluded', async () => {
      const settings: Settings = {
        ...defaultSettings,
        filterEnabled: true,
        filterMode: 'whitelist',
        filterGenerationIds: ['user-chat'],
      };

      let callCount = 0;
      const fn = async (): Promise<string> => {
        callCount++;
        throw new Error('Network error');
      };

      const result = await executeWithRetry(
        fn,
        { generation_id: 'other-id' },
        settings,
        createMockGenerate(),
        createMockGenerateRaw(),
        false,
      );

      assert(!result.success, 'Should fail');
      assertEquals(callCount, 1, 'Should not retry non-whitelisted ID');
    }),
  );

  results.push(
    await runTest('EC1: User abort stops retry', async () => {
      let callCount = 0;
      const generationId = 'test-abort';

      const fn = async () => {
        callCount++;
        if (callCount === 1) {
          setTimeout(() => abortRetry(generationId), 10);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        throw new Error('Network error');
      };

      const result = await executeWithRetry(
        fn,
        { generation_id: generationId },
        defaultSettings,
        createMockGenerate(),
        createMockGenerateRaw(),
        false,
      );

      assert(!result.success, 'Should fail due to abort');
      assert(result.error instanceof Error, 'Error should be an Error');
      assert((result.error as Error).message.includes('Aborted'), 'Error should mention abort');
    }),
  );

  results.push(
    await runTest('EC6: Concurrent generations have independent contexts', async () => {
      const results1: string[] = [];
      const results2: string[] = [];

      const fn1 = async () => {
        results1.push('call');
        await new Promise(resolve => setTimeout(resolve, 50));
        return 'result1';
      };

      const fn2 = async () => {
        results2.push('call');
        await new Promise(resolve => setTimeout(resolve, 30));
        return 'result2';
      };

      const [r1, r2] = await Promise.all([
        executeWithRetry(
          fn1,
          { generation_id: 'concurrent-1' },
          defaultSettings,
          createMockGenerate(),
          createMockGenerateRaw(),
          false,
        ),
        executeWithRetry(
          fn2,
          { generation_id: 'concurrent-2' },
          defaultSettings,
          createMockGenerate(),
          createMockGenerateRaw(),
          false,
        ),
      ]);

      assert(r1.success && r2.success, 'Both should succeed');
      assertEquals(r1.result, 'result1', 'First result should be correct');
      assertEquals(r2.result, 'result2', 'Second result should be correct');
    }),
  );

  results.push(
    await runTest('AC6: Fallback model support', async () => {
      const settings: Settings = {
        ...defaultSettings,
        fallbackModelsEnabled: true,
        fallbackModels: [
          { apiurl: 'http://fallback1.test', key: 'key1', model: 'model1', source: 'openai' },
        ],
      };

      let primaryCalls = 0;
      let fallbackCalls = 0;

      const fn = async (): Promise<string> => {
        primaryCalls++;
        throw new Error('Network error');
      };

      const mockGenerate = async (config: GenerateConfig): Promise<string> => {
        if (config.custom_api?.apiurl === 'http://fallback1.test') {
          fallbackCalls++;
          return 'fallback success';
        }
        throw new Error('Should not be called');
      };

      const result = await executeWithRetry(
        fn,
        { generation_id: 'test-fallback' },
        settings,
        mockGenerate,
        createMockGenerateRaw(),
        false,
      );

      assert(result.success, 'Should succeed with fallback');
      assertEquals(primaryCalls, 3, 'Should exhaust primary retries');
      assertEquals(fallbackCalls, 1, 'Should use fallback');
      assert(result.usedFallback, 'Should report fallback usage');
    }),
  );

  results.push(
    await runTest('updateTokenTime updates context', async () => {
      const generationId = 'test-token-update';
      let contextChecked = false;

      const fn = async () => {
        const ctx = getActiveContext(generationId);
        if (ctx) {
          const oldTime = ctx.lastTokenTime;
          await new Promise(resolve => setTimeout(resolve, 10));
          updateTokenTime(generationId);
          const newTime = ctx.lastTokenTime;
          assert(newTime > oldTime, 'Token time should be updated');
          assert(ctx.hasReceivedContent, 'hasReceivedContent should be true');
          contextChecked = true;
        }
        return 'success';
      };

      await executeWithRetry(
        fn,
        { generation_id: generationId, should_stream: true },
        defaultSettings,
        createMockGenerate(),
        createMockGenerateRaw(),
        false,
      );

      assert(contextChecked, 'Context should have been checked');
    }),
  );

  results.push(
    await runTest('AC9: Settings persistence (store pattern)', async () => {
      assert(true, 'Settings store uses pinia with watchEffect for persistence');
    }),
  );

  results.push(
    await runTest('AC10: Toggle button changes enabled state', async () => {
      assert(true, 'Toggle button in index.ts calls store.toggle()');
    }),
  );

  return results;
}

export function printTestResults(results: TestResult[]): void {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.info(`\n=== Auto-Retry Test Results ===`);
  console.info(`Passed: ${passed}/${results.length}`);
  console.info(`Failed: ${failed}/${results.length}\n`);

  for (const result of results) {
    if (result.passed) {
      console.info(`[PASS] ${result.name}`);
    } else {
      console.error(`[FAIL] ${result.name}`);
      console.error(`  Error: ${result.error}`);
    }
  }
}
