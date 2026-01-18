const FallbackModel = z.object({
  apiurl: z.string(),
  key: z.string(),
  model: z.string(),
  source: z.string().default('openai'),
});

export type FallbackModel = z.infer<typeof FallbackModel>;

const Settings = z
  .object({
    enabled: z.boolean().default(true),

    maxRetries: z.number().int().min(1).max(20).default(3),
    retryDelayMs: z.number().int().min(100).max(60000).default(1000),
    retryDelayMultiplier: z.number().min(1).max(5).default(1.5),

    rateLimitDelayMs: z.number().int().min(1000).max(300000).default(30000),
    rateLimitMaxRetries: z.number().int().min(1).max(10).default(5),

    streamingTimeoutMs: z.number().int().min(5000).max(300000).default(30000),

    requiredContentEnabled: z.boolean().default(false),
    requiredContentPattern: z.string().default(''),
    requiredContentIsRegex: z.boolean().default(false),

    fallbackModelsEnabled: z.boolean().default(false),
    fallbackModels: z.array(FallbackModel).default([]),

    filterEnabled: z.boolean().default(false),
    filterMode: z.enum(['whitelist', 'blacklist']).default('blacklist'),
    filterGenerationIds: z.array(z.string()).default([]),

    showRetryToast: z.boolean().default(true),
    showSuccessToast: z.boolean().default(true),
    showFailureToast: z.boolean().default(true),
  })
  .prefault({});

export type Settings = z.infer<typeof Settings>;

export const useSettingsStore = defineStore('auto-retry-settings', () => {
  const settings = ref<Settings>(Settings.parse(getVariables({ type: 'script', script_id: getScriptId() })));

  watchEffect(() => {
    insertOrAssignVariables(klona(settings.value), { type: 'script', script_id: getScriptId() });
  });

  function toggle() {
    settings.value.enabled = !settings.value.enabled;
  }

  return { settings, toggle };
});
