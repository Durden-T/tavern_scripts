# Auto-Retry Script Specification

## Summary

A tavern helper script that automatically retries failed model generation requests with configurable retry strategies, fallback models, and intelligent error detection.

## Scope

### In Scope
- Auto-retry on model generation failures (network errors, API errors)
- Separate retry intervals for rate limiting (HTTP 429)
- Configurable retry count and delay settings
- Fallback model support
- Filter which requests to retry
- Streaming timeout detection (no updates for too long)
- Thinking time limit detection
- Response content validation (must contain specified text/pattern)
- Settings UI via Vue component
- Toast notifications for retry status

### Out of Scope
- Modifying the original `generate`/`generateRaw` functions
- Retry for non-generation operations (e.g., chat save, world info load)
- Automatic model switching based on cost optimization
- Retry history persistence across sessions

---

## Settings Schema

```typescript
const Settings = z.object({
  enabled: z.boolean().default(true),

  // Retry Configuration
  maxRetries: z.number().int().min(1).max(20).default(3),
  retryDelayMs: z.number().int().min(100).max(60000).default(1000),
  retryDelayMultiplier: z.number().min(1).max(5).default(1.5),

  // Rate Limit (429) Configuration
  rateLimitDelayMs: z.number().int().min(1000).max(300000).default(30000),
  rateLimitMaxRetries: z.number().int().min(1).max(10).default(5),

  // Streaming Timeout
  streamingTimeoutMs: z.number().int().min(5000).max(300000).default(30000),

  // Thinking Time Limit
  thinkingTimeLimitMs: z.number().int().min(10000).max(600000).default(120000),

  // Content Validation
  requiredContentEnabled: z.boolean().default(false),
  requiredContentPattern: z.string().default(''),
  requiredContentIsRegex: z.boolean().default(false),

  // Fallback Models
  fallbackModelsEnabled: z.boolean().default(false),
  fallbackModels: z.array(z.object({
    apiurl: z.string(),
    key: z.string(),
    model: z.string(),
    source: z.string().default('openai'),
  })).default([]),

  // Filter
  filterEnabled: z.boolean().default(false),
  filterMode: z.enum(['whitelist', 'blacklist']).default('blacklist'),
  filterGenerationIds: z.array(z.string()).default([]),

  // Notifications
  showRetryToast: z.boolean().default(true),
  showSuccessToast: z.boolean().default(true),
  showFailureToast: z.boolean().default(true),
}).prefault({});
```

---

## Acceptance Criteria

### AC1: Basic Retry on Generation Failure

**Given** the script is enabled and `maxRetries` is set to 3
**When** a generation request fails with a network/API error
**Then** the script retries up to 3 times with increasing delay
**And** shows a toast "Retry attempt 1/3..." if `showRetryToast` is true

**Example:**
- Request fails at t=0
- Retry 1 at t=1000ms (retryDelayMs)
- Retry 2 at t=2500ms (1000 + 1000*1.5)
- Retry 3 at t=4750ms (2500 + 1000*1.5^2)
- If all fail, show failure toast

### AC2: Rate Limit Handling (HTTP 429)

**Given** the script is enabled and receives an HTTP 429 response
**When** the error is detected as rate limiting
**Then** the script waits `rateLimitDelayMs` before retrying
**And** uses `rateLimitMaxRetries` as the maximum retry count for this error type

**Detection criteria:**
- HTTP status code 429
- Error message contains "rate limit" (case-insensitive)
- Error message contains "too many requests" (case-insensitive)

### AC3: Streaming Timeout Detection

**Given** streaming is enabled (`should_stream: true`)
**When** no `STREAM_TOKEN_RECEIVED_*` events are received for `streamingTimeoutMs`
**Then** the current generation is stopped via `stopGenerationById`
**And** a retry is initiated

**Example:**
- `streamingTimeoutMs = 30000`
- First token received at t=0
- Second token received at t=5000
- No token received by t=35000
- Generation stopped and retry initiated at t=35000

### AC4: Thinking Time Limit

**Given** the generation starts and `thinkingTimeLimitMs` is set to 120000
**When** no response (empty string or no tokens) is received after 120 seconds
**Then** the current generation is stopped
**And** a retry is initiated

**Note:** This differs from streaming timeout in that it applies before any content is received.

### AC5: Content Validation

**Given** `requiredContentEnabled` is true and `requiredContentPattern` is "```json"
**When** the generation completes successfully
**And** the response does NOT contain "```json"
**Then** the response is treated as a failure
**And** a retry is initiated

**Given** `requiredContentIsRegex` is true and pattern is `\{"status":\s*"\w+"\}`
**When** the generation completes
**Then** the pattern is treated as a regex for matching

### AC6: Fallback Model Support

**Given** `fallbackModelsEnabled` is true and fallback models are configured
**When** all retries with the primary model fail
**Then** the script attempts generation with the first fallback model
**And** if that fails, tries the next fallback model
**And** continues until a model succeeds or all are exhausted

**Example:**
- Primary model fails 3 times
- Fallback model A tries (up to 3 times)
- Fallback model B tries (up to 3 times)
- Finally fails if all exhausted

### AC7: Filter by Generation ID

**Given** `filterEnabled` is true and `filterMode` is "blacklist"
**And** `filterGenerationIds` contains ["background-summary"]
**When** a generation request has `generation_id: "background-summary"`
**Then** the script does NOT apply auto-retry to this request

**Given** `filterMode` is "whitelist"
**And** `filterGenerationIds` contains ["user-chat"]
**When** a generation request has `generation_id: "user-chat"`
**Then** auto-retry IS applied
**And** requests without matching ID are NOT retried

### AC8: Streaming and Non-Streaming Compatibility

**Given** a non-streaming request (`should_stream: false` or undefined)
**When** the request fails
**Then** retry works correctly by re-calling `generate`/`generateRaw`
**And** returns the final result as a Promise

**Given** a streaming request (`should_stream: true`)
**When** the request fails or times out
**Then** retry works correctly
**And** streaming events continue to be emitted during retries

### AC9: Settings Persistence

**Given** the user modifies settings via the settings UI
**When** the settings are changed
**Then** they are saved to script variables immediately
**And** persist across script reloads and browser sessions

### AC10: Script Enable/Disable

**Given** the script has a button named "Toggle Auto-Retry"
**When** the user clicks the button
**Then** `settings.enabled` is toggled
**And** a toast shows "Auto-Retry Enabled" or "Auto-Retry Disabled"

---

## Error Detection Logic

```
function isRateLimitError(error: unknown): boolean {
  - Check if error has status code 429
  - Check if error message contains "rate limit" (case-insensitive)
  - Check if error message contains "too many requests" (case-insensitive)
  - Check if error message contains "quota exceeded" (case-insensitive)
  return any of the above
}

function isRetryableError(error: unknown): boolean {
  - Network errors (fetch failed, timeout)
  - HTTP 5xx errors
  - HTTP 429 (rate limit)
  - Connection refused/reset
  return true for above, false for others (4xx except 429)
}
```

---

## Implementation Architecture

```
src/auto-retry/
  index.ts          # Entry point, script initialization
  settings.ts       # Settings store (pinia)
  retry-engine.ts   # Core retry logic
  interceptor.ts    # Intercepts generate/generateRaw calls
  components/
    SettingsPanel.vue  # Settings UI component
```

### Interception Strategy

The script wraps the global `generate` and `generateRaw` functions:

```typescript
const originalGenerate = generate;
const originalGenerateRaw = generateRaw;

window.generate = async (config) => {
  return retryEngine.execute(() => originalGenerate(config), config);
};

window.generateRaw = async (config) => {
  return retryEngine.execute(() => originalGenerateRaw(config), config);
};
```

On script unload, restore the original functions.

---

## Toast Messages

| Event | Message |
|-------|---------|
| Retry initiated | "Auto-retry: Attempt {n}/{max}..." |
| Rate limit wait | "Rate limited. Waiting {seconds}s..." |
| Streaming timeout | "Streaming timeout. Retrying..." |
| Thinking timeout | "Thinking timeout. Retrying..." |
| Content validation fail | "Response missing required content. Retrying..." |
| Fallback model | "Trying fallback model: {model}..." |
| Success after retry | "Auto-retry succeeded on attempt {n}" |
| All retries exhausted | "Auto-retry failed after {n} attempts" |

---

## Edge Cases

1. **User manually stops generation during retry**: Stop all retry attempts, do not continue
2. **Script disabled during retry**: Complete current attempt, then stop
3. **Generation ID not provided**: Use a generated UUID and still apply filter rules (empty ID matches only if explicitly in filter list)
4. **Fallback model configuration invalid**: Skip that fallback, log warning, try next
5. **Zero-length response**: Treat as content validation failure if any pattern is required
6. **Concurrent generations**: Each generation has its own retry context; they do not interfere

---

## Non-Functional Requirements

1. **Performance**: Retry logic overhead < 1ms per generation call
2. **Memory**: Retry contexts cleaned up after completion; no memory leaks
3. **Thread Safety**: Handle concurrent generations correctly
4. **Graceful Degradation**: If retry logic fails, pass through to original function
